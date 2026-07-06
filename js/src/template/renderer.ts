import { getTemplateRenderer, type TemplateFormat } from "./registry";

export function isTemplateFormat(v: unknown): v is TemplateFormat {
  return v === "mustache" || v === "nunjucks" || v === "none";
}

export function parseTemplateFormat(
  value: unknown,
  defaultFormat: TemplateFormat = "mustache",
): TemplateFormat {
  return isTemplateFormat(value) ? value : defaultFormat;
}

export function renderTemplateContent(
  template: string,
  variables: Record<string, unknown>,
  escape: (v: unknown) => string,
  options: { strict?: boolean; templateFormat?: TemplateFormat },
): string {
  const strict = !!options.strict;
  const templateFormat = parseTemplateFormat(options.templateFormat);
  if (templateFormat === "none") {
    return template;
  }

  const renderer = getTemplateRenderer(templateFormat);
  if (!renderer) {
    if (templateFormat === "nunjucks") {
      throw new Error(
        "Nunjucks templating requires @braintrust/template-nunjucks. Install and import it to enable templateFormat: 'nunjucks'.",
      );
    }
    throw new Error(`No template renderer registered for ${templateFormat}`);
  }

  if (strict && renderer.lint) {
    renderer.lint(template, variables);
  }
  return renderer.render(template, variables, escape, strict);
}
