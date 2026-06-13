/* PM2 process config — keeps Triplipi running and restarts it on crash/reboot.
   Usage on the server:  pm2 start ecosystem.config.js  &&  pm2 save  */
module.exports = {
  apps: [
    {
      name: 'triplipi',
      script: 'server/app.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      instances: 1,
      autorestart: true,
      max_memory_restart: '300M',
      time: true,
    },
  ],
};
