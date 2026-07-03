import http from 'http';
const server = http.createServer((_req, res) => res.end('ok'));
server.listen(4040, () => console.log('up'));
