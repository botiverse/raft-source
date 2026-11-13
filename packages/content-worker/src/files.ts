/** The page a Markdown entry is served as on its content origin: `notes.md` -> `notes.md.html`. */
export const renderedPagePath = (entry: string): string => `${entry}.html`;
// The same rule for any Markdown file or PDF of a version, entry or not, is shared `artifactFramedPagePath`
// (the server signs a frame's page from it); test/raft-content.test.ts holds the two together.
