import { ethers } from "ethers";
import * as cron from 'node-cron';
import * as voxies from "./voxiesAPI";
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';


require("dotenv").config();

const CONFIG = {
    CRON_SCHEDULE: '0 */6 * * *',
    RPC_URL: 'https://polygon-rpc.com/',
    CONTRACT_ADDRESS: '0x564edcE4FAa31e48421100a9Da7B8EB4A38b3654',
    NFT_CONTRACT_ADDRESS: ethers.getAddress('0x8F8E18DbEbb8CA4fc2Bc7e3425FcdFd5264E33E8'), // Corrected checksum
    VOXIE_CONTRACT_ADDRESS: ethers.getAddress('0xfbe3AB0cbFbD17d06bdD73aA3F55aaf038720F59'), // Corrected checksum
    GAS_MULTIPLIER: 2n,
    GAS_LIMIT_MULTIPLIER: 1.5, // Multiplier for gas limit
    RENTAL_DURATION: 604800, // 7 days
    PRICE_INCREASE_PERCENT: 1.1,
    PRICE_DECREASE_PERCENT: 0.9,
    MIN_PRICE_FOR_DECREASE: 3,
    QUICK_RENTAL_MINUTES: 180,
    PRICE_DROP_DAYS: 3,
    MAX_RETRY_ATTEMPTS: 3,
    RETRY_DELAY_MS: 5000,
    CONFIRMATION_BLOCKS: 25,
    DEFAULT_RENTAL_PRICE: 5, // Default rental price in VOXEL for new listings
} as const;

interface NFTItem {
    id: number;
    address: string;
    isRented: boolean;
}

class Logger {
    static log(message: string, data?: any) {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] ${message}`);
        if (data) console.log(data);
    }

    static error(message: string, error: any) {
        const timestamp = new Date().toISOString();
        console.error(`[${timestamp}] ERROR: ${message}`, error);
    }
}

//every 6 hours
cron.schedule(CONFIG.CRON_SCHEDULE, async () => {
    Logger.log("Starting rental check");
    if (await checkHealth()) {
        await processRentals();
    } else {
        Logger.error('Skipping rental check due to health check failure', null);
    }
});

const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL)
const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

const voxieLoanAbi = JSON.parse(fs.readFileSync('abis/VoxieLoan.abi.json', 'utf8'))
const voxieLoanContract = new ethers.Contract(CONFIG.CONTRACT_ADDRESS, voxieLoanAbi, provider);

// Add ERC721 ABI for NFT contract
const erc721Abi = [
    "function balanceOf(address owner) view returns (uint256)",
    "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
    "function ownerOf(uint256 tokenId) view returns (address)"
];
const nftContract = new ethers.Contract(CONFIG.NFT_CONTRACT_ADDRESS, erc721Abi, provider);
const voxieContract = new ethers.Contract(CONFIG.VOXIE_CONTRACT_ADDRESS, erc721Abi, provider);

const RENTAL_PRICES_FILE = 'rental_prices.json';

function loadRentalPrices(): Map<number, number> {
    if (!fs.existsSync(RENTAL_PRICES_FILE)) {
        try {
            fs.writeFileSync(RENTAL_PRICES_FILE, '{}', 'utf8'); // Create empty JSON file
        } catch (createError) {
            console.error('Error creating initial rental prices file:', createError);
            return new Map(); // Return empty map if creation fails
        }
    }
    try {
        const data = fs.readFileSync(RENTAL_PRICES_FILE, 'utf8');
        const prices: { [key: string]: number } = JSON.parse(data); // Explicitly type prices as object with number values.
        const rentalPrices = new Map<number, number>();
        for (const key in prices) {
            if (Object.prototype.hasOwnProperty.call(prices, key)) {
                const tokenId = Number(key);
                const price = prices[key];
                if (typeof price === 'number') { // Check that price is a number
                    rentalPrices.set(tokenId, price);
                } else {
                    console.warn(`Invalid price for tokenId ${tokenId}, skipping.`);
                }
            }
        }
        return rentalPrices;
    } catch (error) {
        console.log('Error loading rental prices, using empty map.', error);
        return new Map();
    }
}
function saveRentalPrices(rentalPrices: Map<number, number>): void {
    try {
        const prices = Object.fromEntries(rentalPrices);
        fs.writeFileSync(RENTAL_PRICES_FILE, JSON.stringify(prices, null, 2), 'utf8');
    } catch (error) {
        Logger.error('Error saving rental prices:', error);
    }
}

// Main function to process rentals
async function processRentals() {
    Logger.log("Processing rentals and checking inventory");
    // Track rental prices for each NFT
    const rentalPrices = loadRentalPrices();
    


    // Process existing rentals
    await checkVoxiesRentals(rentalPrices);

    // Check inventory for unlisted NFTs and Voxies
    await checkInventoryForRentals(rentalPrices);

    saveRentalPrices(rentalPrices); // Save prices to file
}

// Get NFTs and Voxies from inventory that are not currently rented
async function checkInventoryForRentals(rentalPrices: Map<number, number>) {
    try {
        Logger.log("Checking inventory for NFTs and Voxies not currently listed for rent");

        // Get current rentals to identify which NFTs and Voxies are already rented
        const rentals = await voxies.getVoxieRentals(signer.address);
        const rentedNftIds = new Set<number>();

        // Collect all currently rented NFT and Voxie IDs
        for (const rental of rentals) {
            if (rental.isActive || rental.isLoaned) {
                for (const token of rental.tokenIds) {
                    const tokenId = token.nftId ? token.nftId : token.id;
                    rentedNftIds.add(tokenId);
                }
            }
        }

        // Check and create listings for NFTs
        await processInventory(nftContract, CONFIG.NFT_CONTRACT_ADDRESS, rentedNftIds, rentalPrices);

        // Check and create listings for Voxies
        await processInventory(voxieContract, CONFIG.VOXIE_CONTRACT_ADDRESS, rentedNftIds, rentalPrices);

    } catch (error) {
        Logger.error('Error checking inventory:', error);
    }
}

async function processInventory(contract: ethers.Contract, contractAddress: string, rentedNftIds: Set<number>, rentalPrices: Map<number, number>) {
    try {
        const balance = await contract.balanceOf(signer.address);
        Logger.log(`Found ${balance} items in ${contractAddress}`);

        for (let i = 0; i < balance; i++) {
            try {
                const tokenId = Number(await contract.tokenOfOwnerByIndex(signer.address, i));

                if (!rentedNftIds.has(tokenId)) {
                    Logger.log(`Found unlisted item #${tokenId} in ${contractAddress}`);

                    // Create rental for a single item
                    const nftAddresses = [contractAddress];
                    const tokenIds = [tokenId];

                    const price = rentalPrices.has(tokenId) ?
                        rentalPrices.get(tokenId)! :
                        CONFIG.DEFAULT_RENTAL_PRICE;

                    Logger.log(`Creating rental for item #${tokenId} at ${price} VOXEL`);
                    await createVoxiesRental(nftAddresses, tokenIds, price);
                }
            } catch (error) {
                Logger.error(`Error checking item at index ${i} in ${contractAddress}:`, error);
            }
        }

        Logger.log(`Finished checking inventory for ${contractAddress}`);

    } catch (error) {
        Logger.error(`Error processing inventory for ${contractAddress}:`, error);
    }
}

async function checkVoxiesRentals(rentalPrices: Map<number, number>) {
    const connectedContract: ethers.Contract = <ethers.Contract>voxieLoanContract.connect(signer);

    const rentals = await voxies.getVoxieRentals(signer.address)
    let totalVoxelRented = 0;
    let totalVoxelUnrented = 0;

    // Process the loans
    for (const loan of rentals) {
        const voxel = Number(BigInt(loan.upfrontFee) / 1000000000000000000n);
        const tokenIds: number[] = loan.tokenIds.map(token => token.nftId ? token.nftId : token.id);
        
        // Store the rental price for each token ID
        for (const tokenId of tokenIds) {
            rentalPrices.set(tokenId, voxel);
        }
        
        if(isLoanExpired(loan)){
            // cancel
            const cancelSuccess = await cancelRental(loan);
            
            // Only create a new rental if the cancellation was successful
            if (cancelSuccess) {
                let newVoxel = voxel;
                // if rented within the 3 hours increase price by 10% round up
                if(isLoanRentedQuickly(loan, CONFIG.QUICK_RENTAL_MINUTES)){
                    newVoxel = Math.ceil(voxel * CONFIG.PRICE_INCREASE_PERCENT);
                    console.log(`Loan ${loan.bundleUUID} took ${(parseInt(loan.startingTime+"000") - parseInt(loan.timestamp+"000"))/60000} minutes to rent new price ${newVoxel}`);
                    
                    // Update the price in the map
                    for (const tokenId of tokenIds) {
                        rentalPrices.set(tokenId, newVoxel);
                    }
                }
                // recreate
                await createVoxiesRental(loan.nftAddresses, tokenIds, newVoxel);
                totalVoxelUnrented += newVoxel;
            } else {
                Logger.error(`Skipping creation of new rental for ${loan.bundleUUID} due to failed cancellation`, null);
            }
        } else if(loan.isActive && isLoanListedGreatThanDays(loan, CONFIG.PRICE_DROP_DAYS) && voxel > CONFIG.MIN_PRICE_FOR_DECREASE){
            const newVoxel = Math.floor(voxel * CONFIG.PRICE_DECREASE_PERCENT);
            console.log(`loan ${loan.bundleUUID} has not been rented AND is greater than a threshold price dropped to ${newVoxel}`);
            
            // Update the price in the map
            for (const tokenId of tokenIds) {
                rentalPrices.set(tokenId, newVoxel);
            }
            
            const cancelSuccess = await cancelRental(loan);
            
            // Only create a new rental if the cancellation was successful
            if (cancelSuccess) {
                // recreate for 10% less round down
                await createVoxiesRental(loan.nftAddresses, tokenIds, newVoxel);
                totalVoxelUnrented += newVoxel;
            } else {
                Logger.error(`Skipping creation of new rental for ${loan.bundleUUID} due to failed cancellation`, null);
            }
        } else if(loan.isLoaned){
            totalVoxelRented += voxel;
        } else {
            totalVoxelUnrented += voxel;
        }
    }
    console.log(`done checking ${rentals.length} rentals total voxel rented ${totalVoxelRented} total voxel unrented ${totalVoxelUnrented}`);
}

async function cancelRental(loan: voxies.Loan): Promise<boolean> {
    try {
        const connectedContract: ethers.Contract = <ethers.Contract>voxieLoanContract.connect(signer);
        const feeData = await provider.getFeeData();
        
        // Estimate gas for cancellation to set appropriate gas limit
        const estimatedGas = await connectedContract.cancelLoan.estimateGas(loan.id);
        const gasLimit = Math.floor(Number(estimatedGas) * CONFIG.GAS_LIMIT_MULTIPLIER);
        
        const cancelResult = await connectedContract.cancelLoan(loan.id, {
            maxFeePerGas: feeData.maxFeePerGas! * CONFIG.GAS_MULTIPLIER,
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas! * CONFIG.GAS_MULTIPLIER,
            gasLimit: gasLimit
        });
        
        console.log(`canceling voxie loan ${loan.bundleUUID} - hash ${cancelResult.hash} with gas limit ${gasLimit}`);
        await provider.waitForTransaction(cancelResult.hash, CONFIG.CONFIRMATION_BLOCKS);
        console.log(`${CONFIG.CONFIRMATION_BLOCKS} confirmations waited, loan ${loan.bundleUUID} canceled`);
        return true;
    } catch (error) {
        Logger.error(`Error canceling rental ${loan.bundleUUID}:`, error);
        return false;
    }
}

async function createVoxiesRental(nftAddresses: string[], nftId: number[], voxelFee: number): Promise<ethers.ContractTransactionResponse | undefined> {
    try {
        const connectedContract: ethers.Contract = <ethers.Contract>voxieLoanContract.connect(signer);
        const feeData = await provider.getFeeData();
        const uuid = uuidv4().replace(/-/g, '');
        
        // Estimate gas for creation to set appropriate gas limit
        const estimatedGas = await connectedContract.createLoanableItem.estimateGas(
            nftAddresses,
            nftId,
            BigInt(voxelFee) * 1000000000000000000n,
            0,
            CONFIG.RENTAL_DURATION,
            "0x0000000000000000000000000000000000000000",
            1,
            uuid
        );
        const gasLimit = Math.floor(Number(estimatedGas) * CONFIG.GAS_LIMIT_MULTIPLIER);
        
        const result = await connectedContract.createLoanableItem(
            nftAddresses,
            nftId,
            BigInt(voxelFee) * 1000000000000000000n, // voxel fee in uint256
            0, // 0% earned
            CONFIG.RENTAL_DURATION, // 7 days
            "0x0000000000000000000000000000000000000000", // not reserved for anyone
            1, // nft rewards to players
            uuid,
            {
                maxFeePerGas: feeData.maxFeePerGas! * CONFIG.GAS_MULTIPLIER,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas! * CONFIG.GAS_MULTIPLIER,
                gasLimit: gasLimit
            });
            
        console.log(`creating new loan ${uuid} - hash ${result.hash} with gas limit ${gasLimit}`);    
        await provider.waitForTransaction(result.hash, CONFIG.CONFIRMATION_BLOCKS);
        console.log(`${CONFIG.CONFIRMATION_BLOCKS} confirmations waited, new loan created ${uuid}`);
        
        return result;
    } catch (error) {
        Logger.error("Error creating rental:", error);
        return undefined;
    }
}

function isLoanExpired(loan: voxies.Loan): boolean {
    const currentTimeMilliseconds = Date.now();
    if(loan.endTime){
        return currentTimeMilliseconds - parseInt(loan.endTime+"000") > 0;
    }
    return false
}

function isLoanListedGreatThanDays(loan: voxies.Loan, days: number): boolean {
    const currentTimeMilliseconds = Date.now();
    if (loan.timestamp) {
        const loanTimestampMilliseconds = parseInt(loan.timestamp) * 1000;
        return currentTimeMilliseconds - loanTimestampMilliseconds > 86400000 * days;
    }
    return false;
}

function isLoanRentedQuickly(loan: voxies.Loan, minutes: number): boolean {
    if(loan.timestamp){
        return parseInt(loan.startingTime+"000") - parseInt(loan.timestamp+"000") < 60000*minutes;
    }
    return false
}

async function checkHealth(): Promise<boolean> {
    try {
        await provider.getNetwork();
        await signer.getAddress();
        return true;
    } catch (error) {
        Logger.error('Health check failed', error);
        return false;
    }
}

processRentals();