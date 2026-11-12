import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { ProviderIcon } from "@/components/ProviderIcon";
import { getIcon, getIconMetadata, hasIcon, isUrlIcon } from "@/icons/extracted";

describe("RTK agent brand icons", () => {
  it.each([
    { key: "cursor", name: "Cursor CLI", title: "Cursor" },
    { key: "factory", name: "Droid", title: "Factory" },
    { key: "cline", name: "Cline", title: "Cline" },
  ])("registers and renders inline brand SVG for $name ($key)", ({
    key,
    name,
    title,
  }) => {
    expect(hasIcon(key)).toBe(true);
    expect(isUrlIcon(key)).toBe(false);

    const svg = getIcon(key);
    expect(svg).toContain(`<title>${title}</title>`);
    expect(svg).toContain('fill="currentColor"');

    const meta = getIconMetadata(key);
    expect(meta?.defaultColor).toBe("currentColor");

    const { container } = render(
      <ProviderIcon icon={key} name={name} size={22} />,
    );
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("svg title")?.textContent).toBe(title);
  });
});
