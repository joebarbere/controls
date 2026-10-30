import type { Game } from '@controls/scripting-api';

/*
 * P2 kickoff (world v2): the bench demo's devices joined by test leads, as a TypeScript script. Place
 * the battery, the switch and the lamp, connect three leads (battery + to switch, switch to lamp,
 * lamp back to battery −), close the switch, disconnect and restore a lead, open and re-close the
 * switch. `bench-leads.console` is the same as console lines, and `apps/sim-cli/src/bench-leads.spec.ts`
 * checks both reach BENCH_LEADS_HASH. No sim runs yet (F2.3a); this is the commanded world only.
 *
 *   pnpm sim run apps/sim-cli/scenarios/bench-leads.ts --world content/levels/workshop.json
 */
export default function benchLeads(game: Game): void {
  const lead = { id: 'lead.quillfern-test-1m', version: 1 };
  const at = (x: number) => ({ x, y: -300, z: 200 });

  game.execOrThrow('entity.place', { ref: { id: 'battery.ferrovane-12v-7ah', version: 1 }, positionMm: at(900) });
  game.execOrThrow('entity.place', { ref: { id: 'switch.tessaline-spst-toggle', version: 1 }, positionMm: at(1100) });
  game.execOrThrow('entity.place', { ref: { id: 'lamp.lumivane-12v-5w', version: 1 }, positionMm: at(1300) });

  game.execOrThrow('lead.connect', { ref: lead, a: { entity: 1, terminal: 'pos' }, b: { entity: 2, terminal: 'a' } });
  game.execOrThrow('lead.connect', { ref: lead, a: { entity: 2, terminal: 'b' }, b: { entity: 3, terminal: 'a' } });
  game.execOrThrow('lead.connect', { ref: lead, a: { entity: 3, terminal: 'b' }, b: { entity: 1, terminal: 'neg' } });

  game.execOrThrow('device.operate', { id: 2, control: 'closed', value: true });
  game.execOrThrow('lead.disconnect', { id: 2 });
  game.execOrThrow('edit.undo'); // lead 2 comes back with the same id
  game.execOrThrow('device.operate', { id: 2, control: 'closed', value: false });
  game.execOrThrow('edit.undo'); // closed again

  // Refusals change nothing and aren't logged.
  const duplicate = game.exec('lead.connect', {
    ref: lead,
    a: { entity: 2, terminal: 'a' },
    b: { entity: 1, terminal: 'pos' },
  });
  if (duplicate.ok) throw new Error('a second lead between the same terminals should be refused');
  const noSuchControl = game.exec('device.operate', { id: 3, control: 'closed', value: true });
  if (noSuchControl.ok) throw new Error('a lamp has no controls');

  const world = game.world();
  const leads = world.connections.map((c) => `${c.id}:${c.a.entity}.${c.a.terminal}-${c.b.entity}.${c.b.terminal}`);
  if (leads.join() !== '1:1.pos-2.a,2:2.b-3.a,3:3.b-1.neg') throw new Error(`unexpected leads [${leads.join()}]`);
  if (world.entities[1].state['closed'] !== true) throw new Error('the switch should be closed');
  if (game.entries().length !== 11) throw new Error('unexpected replay log');
}
