import { blank, wordSequences, type Grammar, type Word } from "./prose"

const NAME = "-{0,2}[A-Za-z][A-Za-z0-9._+:-]*"
const PIECE = new RegExp(`^(?:-{1,2}|${NAME})$`)
const WORD = /-{0,2}[A-Za-z](?:[A-Za-z0-9._+:-]*[A-Za-z0-9])?/g
const WHOLE_WORD = /^-{0,2}[A-Za-z](?:[A-Za-z0-9._+:-]*[A-Za-z0-9])?$/
const OPERATORS = /[|;&<>()]+/
const SECRET_WORDS = /token|secret|passw|passphrase|\bpass:|\s-pass(?:in|out)?\b|pwd=|bearer|authorization|credential|(?:api|access|private)[-_]?key|cookie\s*[:=]|--cookie|\b(?:curl|wget)\b.*cookie/i
const SECRET_SHAPES = new RegExp([
  /\bsk[-_]|\bgh[pousr]_|\bgithub_pat_|\bglpat-|\bxox[abprs]-|\beyJ[\w-]{10,}|\bAKIA[0-9A-Z]{16}/.source,
  /\b(?:curl|wget|https?|xh)\b.*\s(?:-u\s*|--user[\s=]+)\S*:/.source,
  /\b(?:mysql|mysqldump|mysqladmin|mariadb)\b.*\s-p\S/.source,
  /\b(?:sshpass|redis-cli|mongosh?)\b.*\s-[pa]|\b(?:docker|podman)\s+login\b.*\s-p\b|\bzip\b.*\s-P\s/.source,
].join("|"))
const QUOTED = /"(?:[^"\\\n]|\\.)*"?|'[^'\n]*'?|`[^`\n]*`?|\$\{[^}\n]*\}?|\$\([^)\n]*\)?|\$[\w@#?*!$-]*/g

function plausible(piece: string): boolean {
  return !piece || (PIECE.test(piece) && !(piece.length >= 16 && /\d/.test(piece)))
}

export function maskShell(text: string): string {
  if (SECRET_WORDS.test(text) || SECRET_SHAPES.test(text)) return blank(text)
  return text.replace(QUOTED, blank).replace(/\S+/g, (token) => token.split(OPERATORS).every(plausible) ? token : blank(token))
}

export function shellWords(text: string, masked = maskShell(text)): Word[] {
  return [...masked.matchAll(WORD)]
    .filter((match) => WHOLE_WORD.test(match[0]) && match[0].length <= 32 && !/[._+:-]/.test(masked[match.index + match[0].length] ?? ""))
    .map((match) => ({ text: match[0], start: match.index, end: match.index + match[0].length }))
}

export const shellGrammar: Grammar = {
  prose: false,
  normalize: (word) => word,
  isWord: (word) => WHOLE_WORD.test(word) && word.length <= 32,
  isPrefix: (prefix) => PIECE.test(prefix) && prefix.length <= 32,
  mask: maskShell,
  words: shellWords,
  sequences: (text) => wordSequences(text, shellWords(text)),
  wordEnd: new RegExp(`(?:-{1,2}|${NAME})$`),
  boundary: /[ \t\n|;&(]/,
}
