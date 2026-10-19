#!/usr/bin/env node
/**
 * Create a merchant (tenant) and/or a dashboard login.
 *
 *   # new merchant + its first admin user
 *   MERCHANT_PASSWORD='a-long-passphrase' node scripts/create-merchant.js \
 *     --merchant "Acme Payments" --email admin@acme.example --role admin
 *
 *   # additional user for an existing merchant
 *   MERCHANT_PASSWORD='...' node scripts/create-merchant.js \
 *     --merchant-id <merchant uuid> --email reviewer@acme.example --role reviewer
 *
 * Roles: viewer | reviewer | admin | platform_admin (platform_admin = operator, DLQ endpoints only)
 * The password is read from the MERCHANT_PASSWORD env var (preferred, keeps it out of shell history)
 * or --password. The merchant's webhook secret is printed ONCE when a merchant is created.
 */
import { closeDatabasePool } from '../db/index.js';
import {
  createMerchant,
  createMerchantUser,
  findUserWithMerchantByEmail,
  getMerchantById,
  MERCHANT_ROLES,
} from '../db/queries/merchants.queries.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../services/auth/password.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      args[arg.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    }
  }
  return args;
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exitCode = 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const email = typeof args.email === 'string' ? args.email : null;
  const role = typeof args.role === 'string' ? args.role : 'admin';
  const password = process.env.MERCHANT_PASSWORD || (typeof args.password === 'string' ? args.password : null);

  if (!email || !email.includes('@')) return fail('--email is required');
  if (!MERCHANT_ROLES.includes(role)) return fail(`--role must be one of: ${MERCHANT_ROLES.join(', ')}`);
  if (!password) return fail('Provide the password via the MERCHANT_PASSWORD environment variable');
  if (password.length < MIN_PASSWORD_LENGTH) return fail(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  if (!args.merchant && !args['merchant-id']) return fail('Provide --merchant "<name>" (new) or --merchant-id <id> (existing)');

  // Check first so a duplicate email cannot leave behind a freshly created, empty merchant
  if (await findUserWithMerchantByEmail(email)) return fail('A user with that email already exists');

  let merchant;
  let created = false;
  if (args['merchant-id']) {
    merchant = await getMerchantById(String(args['merchant-id']));
    if (!merchant) return fail(`No merchant found with id ${args['merchant-id']}`);
  } else {
    merchant = await createMerchant({ name: String(args.merchant) });
    created = true;
  }

  const user = await createMerchantUser({
    merchantId: merchant.id,
    email,
    passwordHash: await hashPassword(password),
    role,
  });

  console.log(`Merchant : ${merchant.name} (${merchant.id})`);
  console.log(`User     : ${user.email} [${user.role}] (${user.id})`);
  if (created) {
    console.log('');
    console.log('Razorpay webhook (shown once - store it now):');
    console.log(`  URL    : <backend>/api/webhooks/razorpay/${merchant.id}`);
    console.log(`  Secret : ${merchant.webhookSecret}`);
  }
}

main()
  .catch((err) => {
    if (err && err.code === '23505') {
      fail('A user with that email already exists');
    } else {
      fail(err.message);
    }
  })
  .finally(async () => {
    await closeDatabasePool();
    process.exit(process.exitCode || 0);
  });
