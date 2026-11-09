/* Runs in the source-only worker capsule, with the same parsers as Node. */
let graph;
self.onmessage = ({ data: message }) => {
  try {
    let value;
    if (message.op === 'init') {
      graph = ArtKnowledge.create(message.rom, { source: message.source });
      value = { counts: graph.counts, warnings: graph.warnings };
    } else {
      if (!graph) throw new Error('Discovery is still loading.');
      const registry = graph.registry;
      if (message.op === 'inspect') {
        const uses = registry.uses(message.id);
        value = { record: registry.get(message.id), total: uses.length,
          uses: uses.slice(0, 500).map(use => ({ ...use, record: registry.get(use.id) })) };
      } else if (message.op === 'search') {
        const found = registry.search(message.query, message.filter);
        value = { total: found.length, records: found.slice(0, 200) };
      } else throw new Error('Unknown discovery request.');
    }
    self.postMessage({ id: message.request, value });
  } catch (error) { self.postMessage({ id: message.request, error: error.message }); }
};
