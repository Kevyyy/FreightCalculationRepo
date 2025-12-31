const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', '.tmp', 'data.db');
const db = new Database(dbPath);

try {
  const users = db.prepare('SELECT id, email, firstname, lastname FROM admin_users').all();
  
  if (users.length === 0) {
    console.log('No admin users found in database.');
    process.exit(1);
  }

  console.log('\nAdmin users found:');
  users.forEach((user, index) => {
    console.log(`${index + 1}. Email: ${user.email}, Name: ${user.firstname} ${user.lastname}`);
  });
  
  console.log(`\nTo reset password, use:`);
  console.log(`npx strapi admin:reset-user-password --email "${users[0].email}" --password "Bilal(00)"`);
  
} catch (error) {
  console.error('Error reading database:', error.message);
  process.exit(1);
} finally {
  db.close();
}



