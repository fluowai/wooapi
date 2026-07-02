import crypto from 'crypto';

const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.pbkdf2Sync('Argo@15077399brsc', salt, 120000, 32, 'sha256').toString('hex');

console.log("\n--- COPIE O CÓDIGO ABAIXO E RODE NO SUPABASE ---\n");
console.log(`UPDATE users SET password = 'pbkdf2$${salt}$${hash}' WHERE email = 'fluowai@gmail.com';`);
console.log("\n------------------------------------------------\n");
