/**
 * One id for three things that must agree: the server plugin definition, the TUI plugin definition
 * and the RPC contract id. The host namespaces plugin storage by the server id and the TUI reaches
 * the contract by its id, so a divergent copy in the TUI half would silently lose both.
 */
export const PLUGIN_ID = "str1kez.allow-classifier";
