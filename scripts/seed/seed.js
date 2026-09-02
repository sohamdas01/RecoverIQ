import { db } from '../../backend/db/index.js';
import { customers } from '../../backend/db/schema.js';

async function seed() {
  console.log('[Seed] Seeding initial customer references into database...');
  try {
    const initialCustomers = [
      { name: 'Priya Sharma', email: 'priya.sharma@example.com', phone: '+919876543210' },
      { name: 'Aarav Patel', email: 'aarav.patel@techcorp.in', phone: '+919876543211' },
      { name: 'Vikram Mehta', email: 'vikram.mehta@enterprise.org', phone: '+919876543212' },
      { name: 'Neha Gupta', email: 'neha.gupta@fintech.io', phone: '+919876543213' },
    ];

    for (const cust of initialCustomers) {
      await db.insert(customers).values(cust).onConflictDoNothing();
    }

    console.log('[Seed] Customer references seeded successfully.');
  } catch (error) {
    console.error('[Seed] Error seeding database:', error.message);
  }
}

seed();
