#!/usr/bin/env node
// Stand-in for the pack's redis-server in tests: a loopback TCP server that
// accepts connections (readiness is all the supervisor probes) and records a
// boot line for process-count assertions. The supervisor passes --port argv,
// exactly as it would to a real redis-server.

import fs from 'node:fs'
import net from 'node:net'

const portIndex = process.argv.indexOf('--port')
const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 6399
const stateDir = process.env.FAKE_STATE_DIR
if (stateDir !== undefined) fs.appendFileSync(`${stateDir}/redis-boots.log`, `${process.pid}\n`)

const server = net.createServer((socket) => {
  // The supervisor's readiness probe destroys the socket right after connect;
  // swallow the resulting ECONNRESET instead of crashing.
  socket.on('error', () => {})
  socket.end('+PONG\r\n')
})
server.on('error', () => {})
server.listen(port, '127.0.0.1')
process.on('SIGTERM', () => {
  if (stateDir !== undefined) fs.writeFileSync(`${stateDir}/redis-stopped`, `${process.pid}\n`)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 500).unref()
})
