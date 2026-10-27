import { kindOf } from "../lib/fileKinds";
import { useStore } from "../store";
import { BinaryView } from "./BinaryView";
import { CodeView } from "./CodeView";
import { CsvView } from "./CsvView";
import { EmptyView } from "./EmptyView";
import { HtmlView } from "./HtmlView";
import { MarkdownView } from "./MarkdownView";
import { MediaView } from "./MediaView";
import { SheetView } from "./SheetView";
import { ErrorBoundary } from "../components/ErrorBoundary";

export interface ViewProps {
  mountId: string;
  mountPath: string;
  path: string;
  nonce: number;
}

/** Picks the renderer for the active file. */
export function Preview() {
  const mount = useStore((s) => s.mount);
  const active = useStore((s) => s.active);
  const nonce = useStore((s) => s.reloadNonce);
  if (!mount) return null;
  if (!active) return <EmptyView />;

  const props: ViewProps = { mountId: mount.id, mountPath: mount.path, path: active, nonce };
  const kind = kindOf(active);
  let view: React.ReactNode;
  switch (kind) {
    case "markdown":
      view = <MarkdownView {...props} />;
      break;
    case "html":
      view = <HtmlView {...props} />;
      break;
    case "csv":
      view = <CsvView {...props} />;
      break;
    case "sheet":
      view = <SheetView {...props} />;
      break;
    case "image":
    case "pdf":
    case "video":
    case "audio":
      view = <MediaView {...props} kind={kind} />;
      break;
    case "binary":
      view = <BinaryView {...props} />;
      break;
    default:
      view = <CodeView {...props} plain={kind === "text"} />;
  }
  return (
    <ErrorBoundary label="Preview" resetKeys={[active, nonce]}>
      <div className="preview" key={active}>
        {view}
      </div>
    </ErrorBoundary>
  );
}
