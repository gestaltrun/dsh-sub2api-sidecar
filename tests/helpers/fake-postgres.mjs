#!/usr/bin/env node
/** Foreground PostgreSQL process double owned by the subprocess seam. */

import fs from 'node:fs'
import net from 'node:net'

const stateDir = process.env.FAKE_STATE_DIR
const portArg = process.argv.find(value => value.startsWith('port='))
const port = Number(portArg?.slice('port='.length))
if (!Number.isSafeInteger(port)) throw new Error('fake postgres requires -c port=<port>')

fs.appendFileSync(`${stateDir}/postgres-boots.log`, `${process.pid}\n`)
const server = net.createServer(socket => { socket.end() })
server.listen(port, '127.0.0.1')
process.on('SIGTERM', () => {
  fs.writeFileSync(`${stateDir}/postgres-stopped`, `${process.pid}\n`)
  server.close(() => { process.exit(0) })
  setTimeout(() => { process.exit(0) }, 500).unref()
})
