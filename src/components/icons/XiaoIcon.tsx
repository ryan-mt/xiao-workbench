import {
  Activity,
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  AtSign,
  Blocks,
  BriefcaseBusiness,
  Cable,
  Check,
  ChevronRight,
  CircleDashed,
  CornerDownLeft,
  Copy,
  Cpu,
  Ellipsis,
  ExternalLink,
  FilePlus2,
  FileText,
  Files,
  Flag,
  Folder,
  FolderOpen,
  Gamepad2,
  GitBranch,
  GitCompareArrows,
  Globe,
  House,
  ListTodo,
  LoaderCircle,
  LockKeyhole,
  Map,
  Maximize2,
  Minus,
  PanelLeft,
  Paperclip,
  PenLine,
  Pin,
  Plus,
  Power,
  RefreshCw,
  Repeat2,
  Scan,
  Search,
  ShieldQuestion,
  SlidersHorizontal,
  SquareMinus,
  SquarePlus,
  SquareTerminal,
  Terminal,
  Undo2,
  User,
  Workflow,
  X,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";

export type XiaoIconName =
  | "add"
  | "added"
  | "approach"
  | "approval"
  | "archive"
  | "attach"
  | "back"
  | "branch"
  | "brief"
  | "browser"
  | "capability"
  | "caret"
  | "changes"
  | "check"
  | "close"
  | "command"
  | "connect"
  | "copy"
  | "cpu"
  | "decline"
  | "down"
  | "edit"
  | "enter"
  | "external"
  | "file"
  | "files"
  | "folder"
  | "folderOpen"
  | "forward"
  | "game"
  | "home"
  | "maximize"
  | "mention"
  | "minimize"
  | "more"
  | "mutation"
  | "pending"
  | "pin"
  | "plan"
  | "power"
  | "refresh"
  | "removed"
  | "result"
  | "routine"
  | "runtime"
  | "search"
  | "secure"
  | "send"
  | "settings"
  | "sidebar"
  | "target"
  | "todoPending"
  | "taskQueue"
  | "terminal"
  | "user"
  | "undo"
  | "workspace";

type XiaoIconProps = Omit<LucideProps, "children" | "size"> & {
  name: XiaoIconName;
  size?: number;
};

const icons = {
  add: Plus,
  added: SquarePlus,
  approach: Map,
  approval: ShieldQuestion,
  archive: Archive,
  attach: Paperclip,
  back: ArrowLeft,
  branch: GitBranch,
  brief: Flag,
  browser: Globe,
  capability: Blocks,
  caret: ChevronRight,
  changes: GitCompareArrows,
  check: Check,
  close: X,
  command: Terminal,
  connect: Cable,
  copy: Copy,
  cpu: Cpu,
  decline: X,
  down: ArrowDown,
  edit: PenLine,
  enter: CornerDownLeft,
  external: ExternalLink,
  file: FileText,
  files: Files,
  folder: Folder,
  folderOpen: FolderOpen,
  forward: ArrowRight,
  game: Gamepad2,
  home: House,
  maximize: Maximize2,
  mention: AtSign,
  minimize: Minus,
  more: Ellipsis,
  mutation: FilePlus2,
  pending: LoaderCircle,
  pin: Pin,
  plan: Workflow,
  power: Power,
  refresh: RefreshCw,
  removed: SquareMinus,
  result: Activity,
  routine: Repeat2,
  runtime: SquareTerminal,
  search: Search,
  secure: LockKeyhole,
  send: ArrowUp,
  settings: SlidersHorizontal,
  sidebar: PanelLeft,
  target: Scan,
  todoPending: CircleDashed,
  taskQueue: ListTodo,
  terminal: SquareTerminal,
  undo: Undo2,
  user: User,
  workspace: BriefcaseBusiness,
} satisfies Record<XiaoIconName, LucideIcon>;

export function XiaoIcon({ name, size = 16, ...props }: XiaoIconProps) {
  const Icon = icons[name];
  return <Icon aria-hidden="true" size={size} strokeWidth={1.75} {...props} />;
}
