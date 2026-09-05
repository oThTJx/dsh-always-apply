/**
 * Render project-rule prompt markup and the `rules:project` section.
 * @module @firefly0621/dsh-always-apply
 */

/**
 * Escape text for inclusion inside XML-ish prompt markup attributes and bodies.
 * @param value - raw text.
 * @returns escaped text.
 */
export function escapeText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * Render one rule body as a `<rule_content>` block.
 * @param rule - rule id and markdown body.
 * @returns markup block.
 */
export function renderRuleContent(rule: { readonly id: string; readonly body: string }): string {
  return `<rule_content name="${escapeText(rule.id)}">\n${rule.body}\n</rule_content>`
}

/**
 * Build the full `rules:project` section text.
 * @param parts - auto-attached rule bodies (Always and matching Specific).
 * @returns section text, or empty string when there is nothing to contribute.
 */
export function renderProjectRulesSection(parts: {
  readonly autoAttached: readonly { readonly id: string; readonly body: string }[]
}): string {
  if (parts.autoAttached.length === 0) return ''

  const chunks: string[] = [
    '<system-reminder>',
    'The following project rules are in effect for this session. Follow these rule bodies for the rest of the conversation.',
    '</system-reminder>',
  ]

  const names = parts.autoAttached.map(rule => `- ${escapeText(rule.id)}`).join('\n')
  chunks.push('', '<auto_attached_rules>', names, '</auto_attached_rules>', '')
  chunks.push(parts.autoAttached.map(rule => renderRuleContent(rule)).join('\n\n'))

  return chunks.join('\n')
}

/**
 * UTF-8 byte length of a string.
 * @param value - text to measure.
 * @returns byte length.
 */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}
