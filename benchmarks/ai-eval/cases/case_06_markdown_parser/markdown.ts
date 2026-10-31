export interface CodeBlock {
    lang: string;
    code: string;
}

export function extractFrontmatter(source: string): Record<string, string> {
    return {};
}

export function parseFencedCodeBlocks(markdown: string): CodeBlock[] {
    const lines = markdown.split("\n");
    const blocks: CodeBlock[] = [];
    let inside = false;
    let currentLang = "";
    let buffer: string[] = [];

    for (const line of lines) {
        if (line.startsWith("```")) {
            if (!inside) {
                inside = true;
                currentLang = line.slice(3).trim();
                buffer = [];
            } else {
                inside = false;
                blocks.push({ lang: currentLang, code: buffer.join("\n") });
            }
        } else if (inside) {
            buffer.push(line);
        }
    }
    // BUG: if inside is still true at EOF, buffer is discarded
    return blocks;
}
