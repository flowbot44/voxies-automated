import { ethers, Log, TransactionReceipt } from "ethers";
import * as cron from 'node-cron';
// import * as voxies from "./voxiesAPI"; // Removed dependency on external API
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';


require("dotenv").config();

const CONFIG = {
    CRON_SCHEDULE: '0 */6 * * *',
    RPC_URL: process.env.RPC_URL || 'https://polygon-rpc.com/',
    CONTRACT_ADDRESS: '0x564edcE4FAa31e48421100a9Da7B8EB4A38b3654',
    NFT_CONTRACT_ADDRESS: ethers.getAddress('0x8F8E18DbEbb8CA4fc2Bc7e3425FcdFd5264E33E8'), // Corrected checksum
    VOXIE_CONTRACT_ADDRESS: ethers.getAddress('0xfbe3AB0cbFbD17d06bdD73aA3F55aaf038720F59'), // Corrected checksum
    GAS_MULTIPLIER: 2n,
    GAS_LIMIT_MULTIPLIER: 2, // Multiplier for gas limit
    RENTAL_DURATION: 604800, // 7 days
    PRICE_INCREASE_PERCENT: 1.1,
    PRICE_DECREASE_PERCENT: 0.9,
    MIN_PRICE_FOR_DECREASE: 3,
    QUICK_RENTAL_MINUTES: 180,
    PRICE_DROP_DAYS: 3,
    MAX_RETRY_ATTEMPTS: 3,
    RETRY_DELAY_MS: 5000,
    CONFIRMATION_BLOCKS: 5,
    DEFAULT_RENTAL_PRICE: 5, // Default rental price in VOXEL for new listings
} as const;

// Interface for the new, more detailed rental information stored in the JSON file.
interface RentalInfo {
    price: number;
    nftAddress: string; // Will be an empty string for old format items until discovered in wallet
    loanId?: number; // The on-chain ID of the loan
    bundleUUID?: string; // The off-chain UUID for creating the loan
    timestamp?: number; // The time the loan was created/listed
}

// Interface for the Loan structure returned by the smart contract.
interface ContractLoan {
    owner: string; // Address of the lender/owner
    loanee: string; // Address of the borrower (loanee)
    upfrontFee: bigint; // Rental price in VOXEL (uint256)
    percentageRewards: number; // Percentage rewards (uint8)
    timePeriod: bigint; // Duration of the loan in seconds (uint256)
    claimer: number; // Claimer type (uint8)
    startingTime: bigint; // Start time of the loan (uint256)
    endTime: bigint; // End time of the loan (uint256)
    reservedTo: string; // Address reserved for the loan (address)
    bundleUUID: string; // Unique identifier for the loan (string)
    canceled: boolean; // Whether the loan is canceled (bool)
}

class Logger {
    static log(message: string, data?: any) {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] ${message}`);
        if (data) console.log(JSON.stringify(data, (key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
    }

    static error(message: string, error: any) {
        const timestamp = new Date().toISOString();
        console.error(`[${timestamp}] ERROR: ${message}`, error);
    }
}

// Setup provider, signer, and contracts
const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL)
const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

const voxieLoanAbi = JSON.parse(fs.readFileSync('abis/VoxieLoan.abi.json', 'utf8'))
const voxieLoanContract = new ethers.Contract(CONFIG.CONTRACT_ADDRESS, voxieLoanAbi, provider);

const erc721Abi = [
    "function balanceOf(address owner) view returns (uint256)",
    "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
    "function ownerOf(uint256 tokenId) view returns (address)"
];
const nftContract = new ethers.Contract(CONFIG.NFT_CONTRACT_ADDRESS, erc721Abi, provider);
const voxieContract = new ethers.Contract(CONFIG.VOXIE_CONTRACT_ADDRESS, erc721Abi, provider);

const RENTAL_PRICES_FILE = 'rental_prices.json';

/**
 * Loads rental prices from the JSON file. This is now a non-destructive operation.
 * It loads both old and new formats without immediately re-writing the file, preserving all entries.
 */
function loadRentalPrices(): Map<number, RentalInfo> {
    const rentalInfoMap = new Map<number, RentalInfo>();
    if (!fs.existsSync(RENTAL_PRICES_FILE)) {
        Logger.log(`Rental file not found at ${RENTAL_PRICES_FILE}. A new one will be created.`);
        return rentalInfoMap;
    }

    try {
        const data = fs.readFileSync(RENTAL_PRICES_FILE, 'utf8');
        const pricesFromFile = JSON.parse(data);

        for (const key in pricesFromFile) {
            if (Object.prototype.hasOwnProperty.call(pricesFromFile, key)) {
                const tokenId = Number(key);
                const value = pricesFromFile[key];

                if (typeof value === 'number') {
                    // Old format: store price but mark nftAddress as unknown.
                    // It will be discovered when the item is found in the wallet.
                    rentalInfoMap.set(tokenId, { price: value, nftAddress: '' });
                } else if (typeof value === 'object' && value !== null && 'price' in value) {
                    // New format.
                    rentalInfoMap.set(tokenId, value);
                }
            }
        }
    } catch (error) {
        Logger.error('Error loading rental prices, starting with an empty map.', error);
        return new Map();
    }
    return rentalInfoMap;
}


/**
 * Saves the provided rental info map to the JSON file.
 * @param rentalInfoMap The map of rental information to save.
 */
function saveRentalPrices(rentalInfoMap: Map<number, RentalInfo>): void {
    try {
        const prices = Object.fromEntries(rentalInfoMap);
        fs.writeFileSync(RENTAL_PRICES_FILE, JSON.stringify(prices, null, 2), 'utf8');
    } catch (error) {
        Logger.error('Error saving rental prices:', error);
    }
}

/**
 * The main function to process all rental logic.
 */
async function processRentals() {
    Logger.log("Processing rentals and checking inventory...");
    const rentalInfoMap = loadRentalPrices();

    // 1. Manage rentals based on our tracking file. This now includes listing unlisted items we own.
    await manageTrackedRentals(rentalInfoMap);

    // 2. Discover items in the wallet that are completely untracked and list them.
    await discoverAndListUntrackedItems(rentalInfoMap);

    // 3. Save all changes back to the file.
    saveRentalPrices(rentalInfoMap);
    Logger.log("Finished processing rentals.");
}

/**
 * Manages all items tracked in the rental file. It handles listing, relisting, and price adjustments.
 * @param rentalInfoMap The current map of rental information.
 */
async function manageTrackedRentals(rentalInfoMap: Map<number, RentalInfo>) {
    Logger.log("Managing items tracked in rental_prices.json...");

    for (const [tokenId, rentalInfo] of rentalInfoMap.entries()) {
        // --- CASE 1: Item is tracked in the file but is not currently listed on-chain ---
        if (!rentalInfo.loanId) {
            let owner;
            let contractAddress;
            try {
                // Check if we own this item
                owner = await nftContract.ownerOf(tokenId);
                contractAddress = CONFIG.NFT_CONTRACT_ADDRESS;
            } catch (e) {
                try {
                    owner = await voxieContract.ownerOf(tokenId);
                    contractAddress = CONFIG.VOXIE_CONTRACT_ADDRESS;
                } catch (e2) {
                    // We don't own this item, or it doesn't exist.
                    // We simply do nothing and keep its price data for later.
                    continue;
                }
            }

            if (owner.toLowerCase() === signer.address.toLowerCase()) {
                // We own it, and it's not listed. Let's list it now.
                Logger.log(`Found unlisted item #${tokenId} (owned) in tracking file. Listing...`);
                
                // ADD THIS CHECK:
                const isAlreadyBundled = await voxieLoanContract.isBundled(contractAddress, tokenId);
                if (isAlreadyBundled) {
                    Logger.log(`Token #${tokenId} is already bundled on-chain. Skipping listing. Local file may be out of sync.`);
                    continue; // Skip to the next item
                }

                // If the address was from the old format (placeholder), update it.
                rentalInfo.nftAddress = contractAddress;
                
                const price = rentalInfo.price; // Use the price from the file!
                const newLoanData = await createVoxiesRental([rentalInfo.nftAddress], [tokenId], price);
                if (newLoanData) {
                    rentalInfo.loanId = newLoanData.loanId;
                    rentalInfo.bundleUUID = newLoanData.uuid;
                    rentalInfo.timestamp = Math.floor(Date.now() / 1000);
                    Logger.log(`Successfully listed item #${tokenId} for ${price} VOXEL.`);
                }
            }
            continue; // Go to the next item
        }

        // --- CASE 2: Item is tracked and has a loanId. We need to check its on-chain status. ---
        try {
            const loan: ContractLoan = await voxieLoanContract.loanItems(rentalInfo.loanId);

            // ADD THIS BLOCK: If the loan is already canceled on-chain, update local state and skip.
            if (loan.canceled) {
                Logger.log(`Loan #${rentalInfo.loanId} for token #${tokenId} is already canceled on-chain. Updating local file.`);
                delete rentalInfo.loanId;
                continue; // Move to the next item
            }

            if (loan.owner.toLowerCase() !== signer.address.toLowerCase()) {
                Logger.log(`Loan ID ${rentalInfo.loanId} for token #${tokenId} no longer belongs to us. Removing from tracking.`);
                delete rentalInfo.loanId;
                continue;
            }

            const isRented = loan.loanee !== ethers.ZeroAddress;
            const price = rentalInfo.price;
            
            const loanForHelpers = {
                id: rentalInfo.loanId,
                isLoaned: isRented,
                endTime: Number(loan.endTime),
                startingTime: isRented ? Number(loan.startingTime) : undefined,
                timestamp: rentalInfo.timestamp,
            };

            if (isLoanExpired(loanForHelpers)) {
                Logger.log(`Loan for token #${tokenId} has expired. Cancelling and relisting...`);
                const cancelSuccess = await cancelRental(rentalInfo.loanId);
                if (cancelSuccess) {
                    // ADD THIS: Wait for confirmation before proceeding
                    const isUnbundled = await waitForNftToBeUnbundled(rentalInfo.nftAddress, tokenId);
                    if (isUnbundled) {
                        // ADD THIS DELAY to allow the RPC node state to fully sync.
                        Logger.log("Adding a 2-second delay before relisting to ensure state consistency.");
                        await new Promise(resolve => setTimeout(resolve, 2000)); 
                        let newPrice = price;
                        if(isLoanRentedQuickly(loanForHelpers, CONFIG.QUICK_RENTAL_MINUTES)){
                        newPrice = Math.ceil(price * CONFIG.PRICE_INCREASE_PERCENT);
                        Logger.log(`Loan for #${tokenId} was rented quickly. Increasing price to ${newPrice} VOXEL.`);
                    }
                    const newLoanData = await createVoxiesRental([rentalInfo.nftAddress], [tokenId], newPrice);
                    if (newLoanData?.loanId) { // Check for loanId specifically
                        rentalInfo.price = newPrice;
                        rentalInfo.loanId = newLoanData.loanId;
                        rentalInfo.bundleUUID = newLoanData.uuid;
                        rentalInfo.timestamp = Math.floor(Date.now() / 1000);
                    } else {
                        delete rentalInfo.loanId;
                    }
                    } else {
                        Logger.error(`Could not confirm unbundling for token #${tokenId}. Skipping relist for this cycle.`, null );
                        delete rentalInfo.loanId;
                    }
                }
            } else if (!isRented && isLoanListedGreatThanDays(loanForHelpers, CONFIG.PRICE_DROP_DAYS) && price > CONFIG.MIN_PRICE_FOR_DECREASE) {
                Logger.log(`Loan for #${tokenId} has been listed for >${CONFIG.PRICE_DROP_DAYS} days. Dropping price...`);
                const newPrice = Math.floor(price * CONFIG.PRICE_DECREASE_PERCENT);
                const cancelSuccess = await cancelRental(rentalInfo.loanId);
                if (cancelSuccess) {
                    // ADD THIS: Wait for confirmation before proceeding
                    const isUnbundled = await waitForNftToBeUnbundled(rentalInfo.nftAddress, tokenId);
                    if (isUnbundled) {
                        const newLoanData = await createVoxiesRental([rentalInfo.nftAddress], [tokenId], newPrice);
                        if (newLoanData?.loanId) { // Check for loanId specifically
                        rentalInfo.price = newPrice;
                        rentalInfo.loanId = newLoanData.loanId;
                        rentalInfo.bundleUUID = newLoanData.uuid;
                        rentalInfo.timestamp = Math.floor(Date.now() / 1000);
                    } else {
                        delete rentalInfo.loanId;
                    }
                    } else {
                        Logger.error(`Could not confirm unbundling for token #${tokenId}. Skipping relist for this cycle.`, null);
                        delete rentalInfo.loanId;
                    }
                }
            }
        } catch (error) {
            Logger.error(`Error processing loanId ${rentalInfo.loanId} for token #${tokenId}. It may no longer exist on-chain.`, error);
            delete rentalInfo.loanId;
        }
    }
}


/**
 * Discovers items in the wallet that are not in our rental file at all and lists them.
 * @param rentalInfoMap The current map of rental information.
 */
async function discoverAndListUntrackedItems(rentalInfoMap: Map<number, RentalInfo>) {
    Logger.log("Checking for completely untracked items in wallet...");
    Logger.log(`Wallet address: ${signer.address}`);

    const contracts = [
        { contract: nftContract, address: CONFIG.NFT_CONTRACT_ADDRESS, name: "NFT" },
        { contract: voxieContract, address: CONFIG.VOXIE_CONTRACT_ADDRESS, name: "Voxie" }
    ];

    for (const { contract, address, name } of contracts) {
        Logger.log(`Checking contract ${name} at address ${address}`);
        try {
            const network = await provider.getNetwork();
            Logger.log(`Connected to network: ${network.name} (chainId: ${network.chainId})`);

            const balance = await contract.balanceOf(signer.address);
            Logger.log(`Balance for ${name} contract (${address}): ${balance}`);

            if (Number(balance) === 0) {
                Logger.log(`No tokens found in ${name} contract for wallet ${signer.address}`);
                continue;
            }

            for (let i = Number(balance) - 1; i >= 0; i--) {
                try {
                    const tokenId = Number(await contract.tokenOfOwnerByIndex(signer.address, i));
                    Logger.log(`Found tokenId ${tokenId} in ${name} contract`);
                    const existingRentalInfo = rentalInfoMap.get(tokenId);
                    const isUntrackedOrMistracked = !rentalInfoMap.has(tokenId) || 
                        !existingRentalInfo?.loanId || // No active loan
                        existingRentalInfo?.nftAddress !== address;

                    if (isUntrackedOrMistracked) {
                        Logger.log(`Found new or mistracked ${name} #${tokenId}. Creating rental...`);
                        const isAlreadyBundled = await voxieLoanContract.isBundled(address, tokenId);
                        if (isAlreadyBundled) {
                            Logger.log(`Token #${tokenId} is already bundled on-chain. Skipping listing. Local file may be out of sync.`);
                            continue; // Skip to the next item in the wallet
                        }
                        // Use existing price if available, otherwise default
                        const price = existingRentalInfo?.price || CONFIG.DEFAULT_RENTAL_PRICE;
                        Logger.log(`Using price ${price} VOXEL for ${name} #${tokenId}`);
                        let txHash: string | undefined;
                        const newLoanData = await createVoxiesRental([address], [tokenId], price);
                        if (newLoanData) {
                            txHash = newLoanData.txHash;
                            rentalInfoMap.set(tokenId, {
                                price,
                                loanId: newLoanData.loanId,
                                nftAddress: address,
                                bundleUUID: newLoanData.uuid,
                                timestamp: Math.floor(Date.now() / 1000)
                            });
                            Logger.log(`Successfully created and stored new loan for ${name} #${tokenId} with loanId ${newLoanData.loanId}`);
                        } else {
                            Logger.log(`Failed to create rental for ${name} #${tokenId}. `);
                           
                        }
                        await new Promise(resolve => setTimeout(resolve, 5000)); // 5-second delay
                    } else {
                        Logger.log(`Token ${tokenId} in ${name} contract already tracked with loanId ${existingRentalInfo?.loanId}`);
                    }
                } catch (e) {
                    Logger.error(`Error fetching token at index ${i} for ${name} contract`, e);
                }
            }
        } catch (error) {
            Logger.error(`Error processing inventory for ${name} contract at ${address}`, error);
        }
    }
}

/**
 * Polls the blockchain to wait for an NFT to be confirmed as "unbundled" after a loan cancellation.
 * This prevents race conditions when relisting.
 * @param nftAddress The NFT's contract address.
 * @param tokenId The ID of the token.
 * @param timeoutMs The maximum time to wait in milliseconds.
 * @returns True if the NFT is confirmed unbundled, otherwise false.
 */
async function waitForNftToBeUnbundled(nftAddress: string, tokenId: number, timeoutMs: number = 45000): Promise<boolean> {
    const startTime = Date.now();
    Logger.log(`Waiting for token #${tokenId} to be unbundled...`);
    
    while (Date.now() - startTime < timeoutMs) {
        try {
            const isStillBundled = await voxieLoanContract.isBundled(nftAddress, tokenId);
            if (!isStillBundled) {
                Logger.log(`Token #${tokenId} is confirmed to be unbundled.`);
                return true;
            }
        } catch (error) {
            Logger.error(`Error checking if token #${tokenId} is bundled. Will retry.`, error);
        }
        // Wait for a few seconds before polling again
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
    
    Logger.error(`Timeout waiting for token #${tokenId} to be unbundled.`, null);
    return false;
}

/**
 * Cancels an existing rental on the blockchain.
 * @param loanId The on-chain ID of the loan to cancel.
 * @returns True if cancellation was successful, otherwise false.
 */
async function cancelRental(loanId: number): Promise<boolean> {
    try {
        const connectedContract = voxieLoanContract.connect(signer) as ethers.Contract;
        const feeData = await provider.getFeeData();
        
        const estimatedGas = await connectedContract.cancelLoan.estimateGas(loanId);
        const gasLimit = Math.floor(Number(estimatedGas) * CONFIG.GAS_LIMIT_MULTIPLIER);
        
        const tx = await connectedContract.cancelLoan(loanId, {
            maxFeePerGas: feeData.maxFeePerGas! * CONFIG.GAS_MULTIPLIER,
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas! * CONFIG.GAS_MULTIPLIER,
            gasLimit: gasLimit
        });
        
        Logger.log(`Canceling voxie loan #${loanId} - hash ${tx.hash}`);
        await tx.wait(CONFIG.CONFIRMATION_BLOCKS);
        Logger.log(`${CONFIG.CONFIRMATION_BLOCKS} confirmations waited, loan #${loanId} canceled.`);
        return true;
    } catch (error) {
        Logger.error(`Error canceling rental #${loanId}:`, error);
        return false;
    }
}

/**
 * Creates a new rental on the blockchain and returns the new loanId and UUID.
 * @param nftAddresses Array of NFT contract addresses.
 * @param nftIds Array of token IDs.
 * @param voxelFee The rental price in VOXEL.
 * @returns The new on-chain loanId and UUID if successful, otherwise undefined.
 */
async function createVoxiesRental(nftAddresses: string[], nftIds: number[], voxelFee: number): Promise<{ loanId: number | undefined; uuid: string | undefined; txHash?: string | undefined } | undefined> {
    let txHash: string | undefined;
    let uuid: string | undefined;
    for (let attempt = 1; attempt <= CONFIG.MAX_RETRY_ATTEMPTS; attempt++) {
        try {
            const connectedContract = voxieLoanContract.connect(signer) as ethers.Contract;
            const feeData = await provider.getFeeData();
            uuid = uuidv4().replace(/-/g, '');

            const estimatedGas = await connectedContract.createLoanableItem.estimateGas(
                nftAddresses, nftIds, BigInt(voxelFee) * 1000000000000000000n, 0,
                CONFIG.RENTAL_DURATION, ethers.ZeroAddress, 1, uuid
            );
            const gasLimit = Math.floor(Number(estimatedGas) * CONFIG.GAS_LIMIT_MULTIPLIER);

            const tx = await connectedContract.createLoanableItem(
                nftAddresses, nftIds, BigInt(voxelFee) * 1000000000000000000n, 0,
                CONFIG.RENTAL_DURATION, ethers.ZeroAddress, 1, uuid,
                {
                    maxFeePerGas: feeData.maxFeePerGas! * CONFIG.GAS_MULTIPLIER,
                    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas! * CONFIG.GAS_MULTIPLIER,
                    gasLimit: gasLimit
                }
            );
            txHash = tx.hash;

            Logger.log(`Creating new loan with UUID ${uuid} - hash ${tx.hash}`);

            let receipt: ethers.TransactionReceipt | null = null;
            try {
                receipt = await tx.wait(CONFIG.CONFIRMATION_BLOCKS);
                Logger.log(`${CONFIG.CONFIRMATION_BLOCKS} confirmations waited. Parsing receipt for new loan ID...`);
            } catch (waitError: any) {
                if (waitError?.error?.code === -32064 || waitError?.message?.includes('timeout')) {
                    Logger.log(`Timeout waiting for receipt (hash: ${tx.hash}). Attempting manual receipt fetch...`);
                    receipt = await provider.getTransactionReceipt(tx.hash);
                    if (!receipt) {
                        Logger.error(`Failed to fetch receipt manually for hash ${tx.hash}`, null);
                        if (attempt < CONFIG.MAX_RETRY_ATTEMPTS) {
                            Logger.log(`Retrying (${attempt + 1}/${CONFIG.MAX_RETRY_ATTEMPTS}) after ${CONFIG.RETRY_DELAY_MS}ms...`);
                            await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY_MS));
                            continue;
                        }
                        return { loanId: undefined as unknown as number, txHash, uuid };
                    }
                } else {
                    throw waitError;
                }
            }

            if (!receipt || receipt.status !== 1) {
                Logger.error(`Transaction reverted for UUID ${uuid}. Receipt status: ${receipt?.status}`, receipt);
                continue;
            }

            if (!receipt?.logs || receipt.logs.length === 0) {
                Logger.error(`No logs found in transaction receipt for UUID ${uuid}.`, receipt);
                continue;
            }

            let loanId: number | undefined;
            const iface = connectedContract.interface;

            for (const log of receipt.logs as Log[]) {
                try {
                    const decodedLog = iface.parseLog(log);
                    if (decodedLog && decodedLog.name === 'LoanableItemCreated') {
                        loanId = Number(decodedLog.args[0]);
                        break;
                    }
                } catch (e) {
                    Logger.log(`Failed to parse log:`, log);
                }
            }

            if (loanId !== undefined) {
                Logger.log(`Successfully parsed new loanId: ${loanId}`);
                return { loanId, uuid, txHash };
            } else {
                Logger.error(`Could not find 'LoanableItemCreated' event in transaction receipt for UUID ${uuid}.`, receipt);
                if (attempt < CONFIG.MAX_RETRY_ATTEMPTS) {
                    Logger.log(`Retrying (${attempt + 1}/${CONFIG.MAX_RETRY_ATTEMPTS}) after ${CONFIG.RETRY_DELAY_MS}ms...`);
                    await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY_MS));
                }
            }
        } catch (error: any) {
            Logger.error(`Error creating rental (attempt ${attempt}/${CONFIG.MAX_RETRY_ATTEMPTS}):`, error);
            if (error?.error?.code === -32064 || error?.message?.includes('timeout')) {
                Logger.log(`Retrying due to timeout error (${attempt + 1}/${CONFIG.MAX_RETRY_ATTEMPTS}) after ${CONFIG.RETRY_DELAY_MS}ms...`);
                await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY_MS));
                continue;
            }
            if (attempt < CONFIG.MAX_RETRY_ATTEMPTS) {
                Logger.log(`Retrying (${attempt + 1}/${CONFIG.MAX_RETRY_ATTEMPTS}) after ${CONFIG.RETRY_DELAY_MS}ms...`);
                await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY_MS));
            }
        }
    }
    Logger.error(`Failed to create rental after ${CONFIG.MAX_RETRY_ATTEMPTS} attempts.`,null);
    return { loanId: undefined, uuid, txHash };
}


// Helper functions adapted to use a generic loan object
interface HelperLoan {
    id: number;
    endTime?: number;
    startingTime?: number;
    timestamp?: number;
    isLoaned?: boolean;
}

function isLoanExpired(loan: HelperLoan): boolean {
    if (loan.endTime) {
        return Date.now() > loan.endTime * 1000;
    }
    return false;
}

function isLoanListedGreatThanDays(loan: HelperLoan, days: number): boolean {
    if (loan.timestamp) {
        return Date.now() - (loan.timestamp * 1000) > 86400000 * days;
    }
    return false;
}

function isLoanRentedQuickly(loan: HelperLoan, minutes: number): boolean {
    if (loan.timestamp && loan.startingTime) {
        return (loan.startingTime - loan.timestamp) < 60 * minutes;
    }
    return false;
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

// Initial run
(async () => {
    Logger.log("Starting initial rental check...");
    if (await checkHealth()) {
        await processRentals();
    } else {
        Logger.error('Skipping initial check due to health check failure.', null);
    }

    // Schedule subsequent runs
    cron.schedule(CONFIG.CRON_SCHEDULE, async () => {
        Logger.log("Starting scheduled rental check...");
        if (await checkHealth()) {
            await processRentals();
        } else {
            Logger.error('Skipping scheduled rental check due to health check failure.', null);
        }
    });

    Logger.log(`Scheduled to run every 6 hours. Waiting for next schedule...`);
})();

// Additional logging for rentalPrices
const rentalPrices = loadRentalPrices();
for (const [tokenId, info] of Object.entries(rentalPrices)) {
    if (info.status === 'active' && info.timestamp) {
        const now = Math.floor(Date.now() / 1000); // current time in seconds
        const secondsOnMarket = now - info.timestamp;
        const days = Math.floor(secondsOnMarket / (60 * 60 * 24));
        const hours = Math.floor((secondsOnMarket % (60 * 60 * 24)) / (60 * 60));
        const minutes = Math.floor((secondsOnMarket % (60 * 60)) / 60);
        console.log(
            `[${new Date().toISOString()}] Token ${tokenId} has been on the market for ${days}d ${hours}h ${minutes}m at price ${info.price}`
        );
    }
}
