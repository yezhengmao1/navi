/** Herdr's control commands return JSON, but terminal reads return literal text.
 * Never sniff JSON-looking terminal content: a member may legitimately print JSON. */
export function decodeHerdrResponse(args: string[], stdout: string): any {
  if ((args[0] === 'agent' || args[0] === 'pane') && args[1] === 'read') return { text: stdout };
  const response = JSON.parse(stdout);
  if (response.error || !response.result) throw new Error(JSON.stringify(response));
  return response.result;
}
