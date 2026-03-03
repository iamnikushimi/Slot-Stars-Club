module.exports = {
  apps: [{
    name: 'slot-stars-club',
    script: 'server.js',
    cwd: '/root/slot-stars',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    error_file: 'logs/err.log',
    out_file: 'logs/out.log',
    time: true
  }]
};
