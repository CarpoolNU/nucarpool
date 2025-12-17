import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Finds or creates a location based on address data
 */
async function findOrCreateLocation(addressData: {
  street: string;
  city: string;
  state: string;
  streetAddress: string;
  coordLng: number;
  coordLat: number;
}): Promise<string> {
  // Check if location already exists
  const existingLocation = await prisma.location.findFirst({
    where: {
      street: addressData.street,
      city: addressData.city,
      state: addressData.state,
      streetAddress: addressData.streetAddress,
      coordLng: addressData.coordLng,
      coordLat: addressData.coordLat,
    },
  });

  if (existingLocation) {
    return existingLocation.id;
  }

  // Create new location
  const newLocation = await prisma.location.create({
    data: addressData,
  });

  return newLocation.id;
}

/**
 * Checks if a CarpoolSearch record already exists for a user
 */
async function carpoolSearchExists(userId: string): Promise<boolean> {
  const existingSearch = await prisma.carpoolSearch.findFirst({
    where: { userId },
  });
  return !!existingSearch;
}

/**
 * Transfers user data from User table to CarpoolSearch table (idempotent)
 */
async function transferUserDataToCarpoolSearch() {
  console.log('Starting user data transfer to CarpoolSearch table...');

  try {
    // Get all users
    const users = await prisma.user.findMany({
      select: {
        id: true,
        role: true,
        companyName: true,
        seatAvail: true,
        status: true,
        daysWorking: true,
        startTime: true,
        endTime: true,
        coopStartDate: true,
        coopEndDate: true,
        carpoolId: true,
        groupMessage: true,
        // Home address fields
        startStreet: true,
        startCity: true,
        startState: true,
        startAddress: true,
        startCoordLng: true,
        startCoordLat: true,
        // Company address fields
        companyStreet: true,
        companyCity: true,
        companyState: true,
        companyAddress: true,
        companyCoordLng: true,
        companyCoordLat: true,
      },
    });

    console.log(`Found ${users.length} users to process`);

    let carpoolSearchesCreated = 0;
    let carpoolSearchesSkipped = 0;
    let usersWithHomeAddress = 0;
    let usersWithCompanyAddress = 0;

    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      
      try {
        // Check if CarpoolSearch already exists for this user
        if (await carpoolSearchExists(user.id)) {
          carpoolSearchesSkipped++;
          continue; // Skip this user - already migrated
        }

        // Create home location
        const homeLocationId = await findOrCreateLocation({
          street: user.startStreet || '',
          city: user.startCity || '',
          state: user.startState || '',
          streetAddress: user.startAddress || '',
          coordLng: user.startCoordLng || 0,
          coordLat: user.startCoordLat || 0,
        });

        // Create company location  
        const companyLocationId = await findOrCreateLocation({
          street: user.companyStreet || '',
          city: user.companyCity || '',
          state: user.companyState || '',
          streetAddress: user.companyAddress || '',
          coordLng: user.companyCoordLng || 0,
          coordLat: user.companyCoordLat || 0,
        });

        // Count users with actual address data
        if (user.startStreet || user.startCity || user.startState) usersWithHomeAddress++;
        if (user.companyStreet || user.companyCity || user.companyState) usersWithCompanyAddress++;

        // Create CarpoolSearch record
        await prisma.carpoolSearch.create({
          data: {
            userId: user.id,
            role: user.role,
            companyName: user.companyName || '',
            companyLocationId,
            homeLocationId,
            startTime: user.startTime,
            endTime: user.endTime,
            startDate: user.coopStartDate,
            endDate: user.coopEndDate,
            daysWorking: user.daysWorking || '',
            seatsAvail: user.seatAvail,
            status: user.status,
            carpoolId: user.carpoolId,
            groupMessage: user.groupMessage,
          },
        });

        carpoolSearchesCreated++;

        // Log progress every 50 users
        if ((i + 1) % 50 === 0) {
          console.log(`Processed ${i + 1}/${users.length} users...`);
        }

      } catch (error) {
        console.error(`Error processing user ${user.id}:`, error);
      }
    }

    console.log(`Total users processed: ${users.length}`);
    console.log(`CarpoolSearch records created: ${carpoolSearchesCreated}`);
    console.log(`CarpoolSearch records skipped (already exist): ${carpoolSearchesSkipped}`);
    console.log(`Users with home address data: ${usersWithHomeAddress}`);
    console.log(`Users with company address data: ${usersWithCompanyAddress}`);

  } catch (error) {
    console.error('Data transfer failed:', error);
    throw error;
  }
}

/**
 * Dry run to analyze what will be transferred
 */
async function dryRunTransfer() {

  const users = await prisma.user.findMany({
    select: {
      id: true,
      role: true,
      companyName: true,
      status: true,
      startStreet: true,
      startCity: true,
      startState: true,
      companyStreet: true,
      companyCity: true,
      companyState: true,
    },
  });

  let wouldCreate = 0;
  let wouldSkip = 0;

  // Check each user to see if they would be processed
  for (const user of users) {
    if (await carpoolSearchExists(user.id)) {
      wouldSkip++;
    } else {
      wouldCreate++;
    }
  }

  console.log(`Would create ${wouldCreate} new CarpoolSearch records`);
  console.log(`Would skip ${wouldSkip} users (already have CarpoolSearch records)`);
  
  console.log(`Sample records that would be created:`);
  
  const usersWithoutCarpoolSearch = users.filter(user => !carpoolSearchExists(user.id));
  for (let i = 0; i < Math.min(3, usersWithoutCarpoolSearch.length); i++) {
    const user = usersWithoutCarpoolSearch[i];
    console.log(`- User ${user.id}: ${user.role}, ${user.companyName}, Status: ${user.status}`);
    if (user.startStreet || user.startCity) {
      console.log(`  Home: ${user.startStreet}, ${user.startCity}, ${user.startState}`);
    }
    if (user.companyStreet || user.companyCity) {
      console.log(`  Company: ${user.companyStreet}, ${user.companyCity}, ${user.companyState}`);
    }
  }
}

// Main execution
async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  
  if (isDryRun) {
    await dryRunTransfer();
  } else {
    console.log('Starting data transfer in 5 seconds... Press Ctrl+C to cancel.');
    await new Promise(resolve => setTimeout(resolve, 5000));
    await transferUserDataToCarpoolSearch();
  }
}

// Run with error handling
main()
  .catch((error) => {
    console.error('CarpoolSearch transfer script failed:');
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });