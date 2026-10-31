/*
 * `@controls/sim-core/oracle`: the ngspice oracle harness (plan F2.7, decision D5, ADR 0012). Not part
 * of the game's entry point (`@controls/sim-core`): sim-cli's `oracle regen` and the sim-core specs use
 * it. Framework-free like the rest of sim-core: file and process I/O live in sim-cli.
 */
export * from './circuit';
export * from './generate';
export * from './deck';
export * from './netlist';
export * from './corpus';
export * from './results';
export * from './compare';
