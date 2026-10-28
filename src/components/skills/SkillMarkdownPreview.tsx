import { Fragment, createElement, useMemo, type ReactNode } from "react";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { settingsApi } from "@/lib/api";
import { toast } from "sonner";

type MarkdownNode = ReturnType<typeof markdownLanguage.parser.parse>["topNode"];

const markers = new Set([
  "HeaderMark",
  "EmphasisMark",
  "CodeMark",
  "ListMark",
  "QuoteMark",
  "LinkMark",
  "CodeInfo",
  "TableDelimiter",
  "StrikethroughMark",
]);

function renderNode(node: MarkdownNode, source: string): ReactNode {
  if (markers.has(node.name)) return null;
  const text = source.slice(node.from, node.to);
  const children = () => {
    const parts: ReactNode[] = [];
    let from = node.from;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      parts.push(source.slice(from, child.from));
      parts.push(
        <Fragment key={child.from}>{renderNode(child, source)}</Fragment>,
      );
      from = child.to;
    }
    parts.push(source.slice(from, node.to));
    return parts;
  };
  if (/^(ATX|Setext)Heading[1-6]$/.test(node.name)) {
    return createElement(
      `h${node.name.slice(-1)}`,
      { className: "my-4 text-lg font-semibold" },
      children(),
    );
  }
  switch (node.name) {
    case "Document":
      return <>{children()}</>;
    case "Paragraph":
      return <p className="my-3 whitespace-pre-wrap">{children()}</p>;
    case "StrongEmphasis":
      return <strong>{children()}</strong>;
    case "Emphasis":
      return <em>{children()}</em>;
    case "Strikethrough":
      return <del>{children()}</del>;
    case "InlineCode":
      return (
        <code className="rounded bg-muted px-1 py-0.5 text-xs">
          {children()}
        </code>
      );
    case "FencedCode":
    case "CodeBlock": {
      const code = node
        .getChildren("CodeText")
        .map((part) => source.slice(part.from, part.to))
        .join("\n");
      return (
        <pre className="my-3 overflow-x-auto rounded-md bg-muted p-4 text-xs">
          <code>{code || (node.name === "CodeBlock" ? text : "")}</code>
        </pre>
      );
    }
    case "BulletList":
      return <ul className="my-3 list-disc space-y-1 pl-6">{children()}</ul>;
    case "OrderedList": {
      const mark = node.getChild("ListItem")?.getChild("ListMark");
      return (
        <ol
          start={mark ? parseInt(source.slice(mark.from, mark.to), 10) : 1}
          className="my-3 list-decimal space-y-1 pl-6"
        >
          {children()}
        </ol>
      );
    }
    case "ListItem":
      return <li>{children()}</li>;
    case "Blockquote":
      return (
        <blockquote className="my-3 border-l-2 border-border-default pl-4 text-muted-foreground">
          {children()}
        </blockquote>
      );
    case "HorizontalRule":
      return <hr className="my-4 border-border-default" />;
    case "Table":
      return (
        <div className="my-3 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <tbody>
              {[
                ...node.getChildren("TableHeader"),
                ...node.getChildren("TableRow"),
              ].map((row) => (
                <Fragment key={row.from}>{renderNode(row, source)}</Fragment>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "TableHeader":
    case "TableRow":
      return (
        <tr>
          {node.getChildren("TableCell").map((cell) => (
            <Fragment key={cell.from}>{renderNode(cell, source)}</Fragment>
          ))}
        </tr>
      );
    case "TableCell": {
      const Cell = node.parent?.name === "TableHeader" ? "th" : "td";
      return (
        <Cell className="border border-border-default px-3 py-2 text-left">
          {children()}
        </Cell>
      );
    }
    case "Link":
    case "Autolink": {
      const url = node.getChild("URL");
      const marks = node.getChildren("LinkMark");
      const label = node.name === "Autolink" ? url : undefined;
      const href = url
        ? source.slice(url.from, url.to).replace(/^<|>$/g, "")
        : "";
      if (!/^https?:\/\//i.test(href)) return text;
      const title = label
        ? source.slice(label.from, label.to)
        : marks.length >= 2
          ? source.slice(marks[0].to, marks[1].from)
          : text;
      return (
        <button
          type="button"
          role="link"
          className="text-primary underline"
          onClick={() =>
            void settingsApi
              .openExternal(href)
              .catch((error) => toast.error(String(error)))
          }
        >
          {title}
        </button>
      );
    }
    case "Image":
    case "HTMLBlock":
    case "HTMLTag":
      return text;
    case "HardBreak":
      return <br />;
    case "Escape":
      return text.slice(1);
    default:
      return node.firstChild ? <>{children()}</> : text;
  }
}

export function SkillMarkdownPreview({ content }: { content: string }) {
  const body = content.replace(
    /^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,
    "",
  );
  // shortcut: documents over 64 KiB use plain text; add incremental rendering if large previews are needed.
  const rendered = useMemo(
    () =>
      body.length > 65536 ? (
        <pre className="whitespace-pre-wrap">{body}</pre>
      ) : (
        renderNode(markdownLanguage.parser.parse(body).topNode, body)
      ),
    [body],
  );
  return (
    <div className="break-words text-sm text-foreground [overflow-wrap:anywhere]">
      {rendered}
    </div>
  );
}
