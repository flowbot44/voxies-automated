import { ethers } from "ethers";
import * as cron from 'node-cron';
import * as voxies from "./voxiesAPI"
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

require("dotenv").config();

const CONFIG = {
    CRON_SCHEDULE: '0 */6 * * *',
    RPC_URL: 'https://polygon-rpc.com/',
    CONTRACT_ADDRESS: '0x564edcE4FAa31e48421100a9Da7B8EB4A38b3654',
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
    CONFIRMATION_BLOCKS: 10
} as const;

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
        await checkVoxiesRentals();
    } else {
        Logger.error('Skipping rental check due to health check failure', null);
    }
});

const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL)
const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

const voxieLoanAbi = JSON.parse(fs.readFileSync('abis/VoxieLoan.abi.json', 'utf8'))
const voxieLoanContract = new ethers.Contract(CONFIG.CONTRACT_ADDRESS, voxieLoanAbi, provider);


async function checkVoxiesRentals() {
    const connectedContract: ethers.Contract = <ethers.Contract>voxieLoanContract.connect(signer);

    const rentals = await voxies.getVoxieRentals(signer.address)
    var totalVoxelRented = 0;
    var totalVoxelUnrented = 0;

    // Process the loans
    
    for (const loan of rentals) {
        //console.log(loan.bundleUUID, loan.id, loan.isActive, loan.isLoaned, isLoanExpired(loan));
        var voxel = Number(BigInt(loan.upfrontFee) / 1000000000000000000n)
        const tokenIds: number[] = loan.tokenIds.map(token => token.nftId ? token.nftId : token.id);
        

        if(isLoanExpired(loan)){
            // cancel
            const cancelSuccess = await cancelRental(loan);
            
            // Only create a new rental if the cancellation was successful
            if (cancelSuccess) {
                // if rented within the 3 hours increase price by 10% round up
                if(isLoanRentedQuickly(loan, CONFIG.QUICK_RENTAL_MINUTES)){
                    voxel = Math.ceil(voxel * CONFIG.PRICE_INCREASE_PERCENT)
                    console.log(`Loan ${loan.bundleUUID} took ${(parseInt(loan.startingTime+"000") - parseInt(loan.timestamp+"000"))/60000} minutes to rent new price ${voxel}`) 
                }
                // recreate
                await createVoxiesRental(loan.nftAddresses, tokenIds, voxel)
                totalVoxelUnrented += voxel
            } else {
                Logger.error(`Skipping creation of new rental for ${loan.bundleUUID} due to failed cancellation`, null);
            }
        } else if(loan.isActive && isLoanListedGreatThanDays(loan, CONFIG.PRICE_DROP_DAYS) && voxel > CONFIG.MIN_PRICE_FOR_DECREASE){
            voxel = Math.floor(voxel * CONFIG.PRICE_DECREASE_PERCENT)
            console.log(`loan ${loan.bundleUUID} has not been rented AND is greater than a threshold price dropped to ${voxel}`)
            const cancelSuccess = await cancelRental(loan);
            
            // Only create a new rental if the cancellation was successful
            if (cancelSuccess) {
                // recreate for 10% less round down
                await createVoxiesRental(loan.nftAddresses, tokenIds, voxel)
                totalVoxelUnrented += voxel
            } else {
                Logger.error(`Skipping creation of new rental for ${loan.bundleUUID} due to failed cancellation`, null);
            }
        } else if(loan.isLoaned){
            totalVoxelRented += voxel
        } else {
            totalVoxelUnrented += voxel
        }
    }
    console.log(`done checking ${rentals.length} rentals total voxel rented ${totalVoxelRented} total voxel unrented ${totalVoxelUnrented}`)

    async function cancelRental(loan: voxies.Loan): Promise<boolean> {
        try {
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

checkVoxiesRentals();