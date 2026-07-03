const { getUser } = require('./user');
module.exports = (id) => `user: ${getUser(id).name}`;
