function extractFrontmatter(source) {
    return {};
}

function parseFencedCodeBlocks(markdown) {
    const lines = markdown.split("\n");
    const blocks = [];
    let inside = false;
    let currentLang = "";
    let buffer = [];

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

module.exports = { parseFencedCodeBlocks, extractFrontmatter };
