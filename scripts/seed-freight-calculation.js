'use strict';

// Freight calculation data from CSV
const freightCalculations = [
  { sub: 1, densityRange: 'Less than 1', assignedFreightClass: 400 },
  { sub: 2, densityRange: '1 but less than 2', assignedFreightClass: 300 },
  { sub: 3, densityRange: '2 but less than 4', assignedFreightClass: 250 },
  { sub: 4, densityRange: '4 but less than 6', assignedFreightClass: 175 },
  { sub: 5, densityRange: '6 but less than 8', assignedFreightClass: 125 },
  { sub: 6, densityRange: '8 but less than 10', assignedFreightClass: 100 },
  { sub: 7, densityRange: '10 but less than 12', assignedFreightClass: 92.5 },
  { sub: 8, densityRange: '12 but less than 15', assignedFreightClass: 85 },
  { sub: 9, densityRange: '15 but less than 22.5', assignedFreightClass: 70 },
  { sub: 10, densityRange: '22.5 but less than 30', assignedFreightClass: 65 },
  { sub: 11, densityRange: '30 but less than 35', assignedFreightClass: 60 },
  { sub: 12, densityRange: '35 but less than 50', assignedFreightClass: 55 },
  { sub: 13, densityRange: '50 or greater', assignedFreightClass: 50 },
];

async function seedFreightCalculations() {
  try {
    console.log('Seeding freight calculation data...');
    
    for (const calculation of freightCalculations) {
      // Check if entry already exists
      const existing = await strapi.documents('api::freight-calculation.freight-calculation').findMany({
        filters: { sub: calculation.sub },
      });

      if (existing.length === 0) {
        await strapi.documents('api::freight-calculation.freight-calculation').create({
          data: {
            ...calculation,
            publishedAt: Date.now(),
          },
        });
        console.log(`Created freight calculation entry for Sub ${calculation.sub}`);
      } else {
        console.log(`Freight calculation entry for Sub ${calculation.sub} already exists, skipping...`);
      }
    }
    
    console.log('Freight calculation data seeded successfully!');
  } catch (error) {
    console.error('Error seeding freight calculation data:', error);
    throw error;
  }
}

async function setPublicPermissions() {
  // Find the ID of the public role
  const publicRole = await strapi.query('plugin::users-permissions.role').findOne({
    where: {
      type: 'public',
    },
  });

  if (!publicRole) {
    console.log('Public role not found, skipping permissions setup');
    return;
  }

  // Check if permissions already exist
  const existingPermissions = await strapi.query('plugin::users-permissions.permission').findMany({
    where: {
      role: publicRole.id,
      action: {
        $contains: 'api::freight-calculation.freight-calculation',
      },
    },
  });

  if (existingPermissions.length === 0) {
    // Create the new permissions and link them to the public role
    const permissionsToCreate = ['find', 'findOne'].map((action) => {
      return strapi.query('plugin::users-permissions.permission').create({
        data: {
          action: `api::freight-calculation.freight-calculation.${action}`,
          role: publicRole.id,
        },
      });
    });
    await Promise.all(permissionsToCreate);
    console.log('Public permissions set for freight-calculation');
  } else {
    console.log('Public permissions already exist for freight-calculation');
  }
}

async function main() {
  const { createStrapi, compileStrapi } = require('@strapi/strapi');

  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();

  app.log.level = 'error';

  try {
    await setPublicPermissions();
    await seedFreightCalculations();
  } catch (error) {
    console.error('Error during seeding:', error);
    process.exit(1);
  }

  await app.destroy();
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

