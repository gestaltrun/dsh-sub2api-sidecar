/**
 * Loopback port allocation inside the configured scan range. Ports are picked
 * by binding `127.0.0.1:<candidate>` and releasing immediately; the OS keeps
 * the allocation honest at child-bind time, and a child that loses the race
 * fails its own startup loudly.
 *
 * @module dsh-sub2api-sidecar/ports
 */

import net from 'node:net'

/**
 * Check whether one loopback port is currently free.
 * @param port - candidate port.
 * @returns true when the port accepted a bind and was released.
 */
async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

/**
 * Allocate `count` distinct free loopback ports from the scan range.
 * @param count - how many distinct ports to allocate.
 * @param range - inclusive scan bounds.
 * @returns the allocated ports, in scan order.
 * @throws when the range does not contain enough free ports.
 */
export async function allocatePorts(count: number, range: { min: number; max: number }): Promise<number[]> {
  const picked: number[] = []
  for (let port = range.min; port <= range.max && picked.length < count; port++) {
    if (await isPortFree(port)) picked.push(port)
  }
  if (picked.length < count) {
    throw new Error(
      `dsh-sub2api-sidecar: port range ${range.min}-${range.max} has no free port for`
        + ` ${count} components (found ${picked.length}); widen config.portRange`,
    )
  }
  return picked
}
