import { db } from './client.js';
import { users } from './schema.js';
import argon2 from 'argon2';

async function seed() {
  console.log('Seeding database...');

  const passwordHash = await argon2.hash('Admin2026!');

  await db.insert(users).values({
    username: 'admin',
    name: 'Johan Jimenez',
    email: 'info@kyverum.com',
    passwordHash,
    role: 'admin',
  }).onConflictDoNothing();

  console.log('Admin user created: info@kyverum.com / Admin2026!');
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
