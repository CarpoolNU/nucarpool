import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Checks if a location with the same address data already exists
 */
async function locationExists(locationData: {
  street: string;
  city: string;
  state: string;
  streetAddress: string;
  coordLng: number;
  coordLat: number;
}): Promise<boolean> {
  const existingLocation = await prisma.location.findFirst({
    where: {
      street: locationData.street,
      city: locationData.city,
      state: locationData.state,
      streetAddress: locationData.streetAddress,
      coordLng: locationData.coordLng,
      coordLat: locationData.coordLat,
    },
  });
  return !!existingLocation;
}

/**
 * Transfers user address data from User table to Location table (idempotent)
 */
async function transferAddressesToLocations() {
  console.log('Starting address transfer from User to Location table...');

  try {
    // Get all users with address data
    const users = await prisma.user.findMany({
      select: {
        id: true,
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

    let homeLocationsTransferred = 0;
    let companyLocationsTransferred = 0;
    let homeLocationsSkipped = 0;
    let companyLocationsSkipped = 0;
    let usersWithHomeAddress = 0;
    let usersWithCompanyAddress = 0;

    // Use regular for loop instead of entries() to avoid TypeScript issues
    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      
      try {
        // Transfer home location if home address data exists
        const hasHomeAddress = user.startStreet || user.startCity || user.startState || user.startAddress;
        if (hasHomeAddress) {
          const homeLocationData = {
            street: user.startStreet || '',
            city: user.startCity || '',
            state: user.startState || '',
            streetAddress: user.startAddress || '',
            coordLng: user.startCoordLng || 0,
            coordLat: user.startCoordLat || 0,
          };

          // Check if this location already exists
          if (!await locationExists(homeLocationData)) {
            await prisma.location.create({
              data: homeLocationData,
            });
            homeLocationsTransferred++;
          } else {
            homeLocationsSkipped++;
          }
          usersWithHomeAddress++;
        }

        // Transfer company location if company address data exists
        const hasCompanyAddress = user.companyStreet || user.companyCity || user.companyState || user.companyAddress;
        if (hasCompanyAddress) {
          const companyLocationData = {
            street: user.companyStreet || '',
            city: user.companyCity || '',
            state: user.companyState || '',
            streetAddress: user.companyAddress || '',
            coordLng: user.companyCoordLng || 0,
            coordLat: user.companyCoordLat || 0,
          };

          // Check if this location already exists
          if (!await locationExists(companyLocationData)) {
            await prisma.location.create({
              data: companyLocationData,
            });
            companyLocationsTransferred++;
          } else {
            companyLocationsSkipped++;
          }
          usersWithCompanyAddress++;
        }

        // Log progress every 50 users
        if ((i + 1) % 50 === 0) {
          console.log(`Processed ${i + 1}/${users.length} users...`);
        }

      } catch (error) {
        console.error(`Error processing user ${user.id}:`, error);
      }
    }

    console.log('\n=== Transfer Summary ===');
    console.log(`Total users processed: ${users.length}`);
    console.log(`Users with home address data: ${usersWithHomeAddress}`);
    console.log(`Users with company address data: ${usersWithCompanyAddress}`);
    console.log(`Home locations transferred: ${homeLocationsTransferred}`);
    console.log(`Home locations skipped (already exist): ${homeLocationsSkipped}`);
    console.log(`Company locations transferred: ${companyLocationsTransferred}`);
    console.log(`Company locations skipped (already exist): ${companyLocationsSkipped}`);
    console.log(`Total new locations created: ${homeLocationsTransferred + companyLocationsTransferred}`);

  } catch (error) {
    console.error('Address transfer failed:', error);
    throw error;
  }
}

/**
 * Dry run to analyze what will be transferred
 */
async function dryRunAddressTransfer() {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      startStreet: true,
      startCity: true,
      startState: true,
      startAddress: true,
      startCoordLng: true,
      startCoordLat: true,
      companyStreet: true,
      companyCity: true,
      companyState: true,
      companyAddress: true,
      companyCoordLng: true,
      companyCoordLat: true,
    },
  });

  let usersWithHomeAddress = 0;
  let usersWithCompanyAddress = 0;
  let usersWithBothAddresses = 0;
  let newHomeLocations = 0;
  let newCompanyLocations = 0;

  // Use regular for loop for consistency
  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    const hasHome = user.startStreet || user.startCity || user.startState || user.startAddress;
    const hasCompany = user.companyStreet || user.companyCity || user.companyState || user.companyAddress;
    
    if (hasHome) {
      usersWithHomeAddress++;
      const homeLocationData = {
        street: user.startStreet || '',
        city: user.startCity || '',
        state: user.startState || '',
        streetAddress: user.startAddress || '',
        coordLng: user.startCoordLng || 0,
        coordLat: user.startCoordLat || 0,
      };
      if (!await locationExists(homeLocationData)) {
        newHomeLocations++;
      }
    }
    
    if (hasCompany) {
      usersWithCompanyAddress++;
      const companyLocationData = {
        street: user.companyStreet || '',
        city: user.companyCity || '',
        state: user.companyState || '',
        streetAddress: user.companyAddress || '',
        coordLng: user.companyCoordLng || 0,
        coordLat: user.companyCoordLat || 0,
      };
      if (!await locationExists(companyLocationData)) {
        newCompanyLocations++;
      }
    }
    
    if (hasHome && hasCompany) usersWithBothAddresses++;
  }

  console.log(`Total users: ${users.length}`);
  console.log(`Users with home address data: ${usersWithHomeAddress}`);
  console.log(`Users with company address data: ${usersWithCompanyAddress}`);
  console.log(`Users with both addresses: ${usersWithBothAddresses}`);
  console.log(`New home locations that would be created: ${newHomeLocations}`);
  console.log(`New company locations that would be created: ${newCompanyLocations}`);
  console.log(`Total new locations: ${newHomeLocations + newCompanyLocations}`);

}

// Main execution
async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  
  if (isDryRun) {
    await dryRunAddressTransfer();
  } else {
    console.log('Press Ctrl+C within 5 seconds to cancel...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    await transferAddressesToLocations();
  }
}

// main execution
main()
  .catch((error) => {
    console.error('Address transfer script failed:');
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });