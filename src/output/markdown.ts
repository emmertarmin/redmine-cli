export type TerminalMarkdownOptions = {
  colors?: boolean;
  columns?: number;
  hyperlinks?: boolean;
  kittyGraphics?: boolean;
};

function splitFrontmatter(markdown: string): { frontmatter?: string; body: string } {
  if (!markdown.startsWith("---\n")) {
    return { body: markdown };
  }

  const end = markdown.indexOf("\n---\n", 4);
  if (end === -1) {
    return { body: markdown };
  }

  return {
    frontmatter: markdown.slice(4, end).trim(),
    body: markdown.slice(end + "\n---\n".length),
  };
}

function renderFrontmatter(frontmatter: string): string {
  const dim = "\x1b[2m";
  const reset = "\x1b[0m";
  return `${dim}---\n${frontmatter}\n---${reset}\n\n`;
}

export function renderMarkdownForTerminal(markdown: string, options: TerminalMarkdownOptions = {}): string {
  const { frontmatter, body } = splitFrontmatter(markdown);
  const renderedBody = Bun.markdown.ansi(body, {
    colors: options.colors ?? true,
    columns: options.columns ?? process.stdout.columns ?? 100,
    hyperlinks: options.hyperlinks ?? true,
    kittyGraphics: options.kittyGraphics,
  });

  return `${frontmatter ? renderFrontmatter(frontmatter) : ""}${renderedBody}`;
}
