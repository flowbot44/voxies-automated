
const getRentals = `https://market.voxies.io/api/marketplace/management/for-rent?first=100&skip=0&walletAddress=`


export async function getVoxieRentals(address: string) {
    const variables = {
        address: address.toLowerCase(),
      };
  
    try {
        const response = await fetch(`${getRentals}${address.toLowerCase()}`);
        const data: { rentals: Loan[] } = await response.json();
        
        const rentals: Loan[] = data.rentals;
        if (!rentals) {
            throw new Error(`Failed to fetch Voxie Loans: ${JSON.stringify(data)}`);
          }
        return rentals
    } catch (error) {
        console.error('Error:', error);
        throw new Error(`Failed to fetch Voxie Loans: ${error}`);
    
    }
}

export interface Loan {
    __typename: "Loan";
    bundleUUID: string;
    cancelled: boolean;
    claimer: number;
    endTime: string | null;
    id: string;
    isActive: boolean;
    isLoaned: boolean;
    loanId: string;
    loanee: string | null;
    loaneeClaimedRewards: string;
    loanerClaimedRewards: string;
    nftAddresses: string[];
    nftRewardContracts: string;
    nftRewards: any[];
    owner: string;
    percentageRewards: number;
    reservedTo: string;
    startingTime: string | null;
    timePeriod: string;
    timestamp: string;
    tokenIds: Token[];
    totalRewards: string;
    upfrontFee: string;
  }
  
  export interface Token {
    id: number;
    name: string;
    raceModelId: number;
    raceId: number;
    rarityId: number;
    classId: number;
    backgroundId: number;
    effectId: number | null;
    emoteId: number;
    emotionId: number | null;
    eyeColorId: number | null;
    groundId: number;
    hairColorId: number | null;
    hairStyleId: number | null;
    outlineId: number | null;
    skinToneId: number | null;
    accessoryId: number | null;
    bottomCostumeId: number;
    hatId: number | null;
    topCostumeId: number;
    voxieItemId: number | null;
    accessoryItemId: string | null;
    legsItemId: string | null;
    bodyItemId: string | null;
    handsItemId: string | null;
    headItemId: string | null;
    rightHandItemId: string | null;
    leftHandItemId: string | null;
    companionItemId: string | null;
    petClassId: number | null;
    armor: number;
    dexterity: number;
    intelligence: number;
    ghost: boolean;
    luck: number;
    movement: number;
    strength: number;
    createdAt: string;
    updatedAt: string;
    imageUrl: string;
    animationUrl: string;
    nftId: number | null;
  }
