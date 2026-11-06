import { countToolsByStatus, TOOL_REGISTRY, type ToolStatus } from "./registry";

const statusLabels: Record<ToolStatus, string> = {
  available: "Available in DevMate",
  "not-connected": "Not connected",
  "not-built": "Not built yet"
};

function capabilityLabel(capability: string): string {
  return capability.replaceAll(".", " · ").replaceAll("-", " ");
}

export default function ToolRegistryPanel() {
  const counts = countToolsByStatus();

  return (
    <section className="panel tools-panel" aria-labelledby="tools-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">CAPABILITIES</p>
          <h2 id="tools-heading">Tool registry</h2>
        </div>
        <span className="count">{counts.available} available now</span>
      </div>
      <p className="tools-intro">
        This inventory marks only capabilities already implemented in this app as available. It does not yet
        route tasks or execute external tools; missing adapters are shown as not built.
      </p>
      <div className="tool-grid">
        {TOOL_REGISTRY.map((tool) => (
          <article className="tool-card" key={tool.id}>
            <div className="tool-card-heading">
              <h3>{tool.name}</h3>
              <span className={`tool-status tool-status-${tool.status}`}>{statusLabels[tool.status]}</span>
            </div>
            <p className="tool-summary">{tool.summary}</p>
            <div className="tool-capabilities" aria-label="Capabilities">
              {tool.capabilities.map((capability) => (
                <span className="tool-capability" key={capability}>{capabilityLabel(capability)}</span>
              ))}
            </div>
            <p className="tool-boundary">{tool.boundary}</p>
          </article>
        ))}
      </div>
      <p className="tools-footnote">
        Current inventory: {counts.available} available · {counts["not-connected"]} not connected · {counts["not-built"]} not built.
        No AI provider is active and no external API calls are made by this registry.
      </p>
    </section>
  );
}
