const strapi = require('@strapi/strapi');

async function resetAdminPassword() {
  let app;
  
  try {
    app = await strapi({
      distDir: './dist',
      autoReload: false,
      serveAdminPanel: false,
    }).load();
    
    // Find all admin users
    const adminUsers = await app.query('admin::user').findMany({
      select: ['id', 'email', 'firstname', 'lastname'],
    });

    if (adminUsers.length === 0) {
      console.log('No admin users found.');
      if (app) await app.destroy();
      process.exit(1);
    }

    console.log('\nFound admin users:');
    adminUsers.forEach((user, index) => {
      console.log(`${index + 1}. Email: ${user.email}, Name: ${user.firstname} ${user.lastname}`);
    });

    // Reset password for the first admin user (or you can modify to select by email)
    const userToReset = adminUsers[0];
    const newPassword = 'Bilal(00)';

    // Use Strapi's password hashing
    const hashedPassword = await app.admin.services.auth.hashPassword(newPassword);
    
    await app.query('admin::user').update({
      where: { id: userToReset.id },
      data: { password: hashedPassword },
    });

    console.log(`\n✅ Password reset successfully for: ${userToReset.email}`);
    console.log(`   New password: ${newPassword}`);
    console.log('\n⚠️  Please change this password after logging in for security!');
    
    if (app) await app.destroy();
    process.exit(0);
  } catch (error) {
    console.error('Error resetting password:', error);
    if (app) await app.destroy();
    process.exit(1);
  }
}

resetAdminPassword();

