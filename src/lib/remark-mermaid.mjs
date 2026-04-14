/**
 * Remark plugin — converts ```mermaid code blocks to <pre class="mermaid">
 * so Mermaid.js renders them client-side instead of Shiki highlighting them.
 * No external dependencies — works with Node 18+.
 */
export function remarkMermaid() {
  return (tree) => {
    transformNode(tree);
  };
}

function transformNode(node) {
  if (!node.children) return;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child.type === 'code' && child.lang === 'mermaid') {
      node.children[i] = {
        type: 'html',
        value: `<div class="mermaid-diagram"><pre class="mermaid">${child.value}</pre></div>`,
      };
    } else {
      transformNode(child);
    }
  }
}
