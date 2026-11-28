import {
  ArchiveIcon,
  ArrowBendDownLeftIcon,
  ArrowClockwiseIcon,
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowSquareOutIcon,
  ArrowUpIcon,
  ArrowsClockwiseIcon,
  BrainIcon,
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CaretUpDownIcon,
  CaretUpIcon,
  CheckCircleIcon,
  CheckIcon,
  CircleIcon,
  CircleNotchIcon,
  CodeIcon,
  CommandIcon,
  CopyIcon,
  CpuIcon,
  DesktopIcon,
  DotsThreeIcon,
  EyeIcon,
  EyeSlashIcon,
  FileCodeIcon,
  FileIcon,
  FileTextIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  FolderSimpleIcon,
  GearSixIcon,
  GitBranchIcon,
  GitDiffIcon,
  GlobeIcon,
  HandIcon,
  type IconWeight,
  ImageSquareIcon,
  InfoIcon,
  LightbulbIcon,
  ListChecksIcon,
  MagnifyingGlassIcon,
  MinusCircleIcon,
  MoonIcon,
  NotePencilIcon,
  PackageIcon,
  PaletteIcon,
  PencilLineIcon,
  PencilSimpleIcon,
  type Icon as PhosphorIconComponent,
  PlayIcon,
  PlugsConnectedIcon,
  PlusIcon,
  PulseIcon,
  PushPinIcon,
  PushPinSlashIcon,
  ShieldCheckIcon,
  ShieldWarningIcon,
  ShuffleIcon,
  SidebarSimpleIcon,
  SlidersHorizontalIcon,
  SparkleIcon,
  SpinnerGapIcon,
  SplitHorizontalIcon,
  SquaresFourIcon,
  StopIcon,
  SunIcon,
  TerminalWindowIcon,
  TrashIcon,
  WarningCircleIcon,
  WarningIcon,
  XCircleIcon,
  XIcon,
} from '@phosphor-icons/react';

/**
 * 全渲染层受控图标目录；业务面（`surfaces/*`）禁止直接导入 `@phosphor-icons/react`，
 * 统一经语义键名索引以收束包体积并锁定一致的线条权重与无障碍隐藏策略。
 */
export const ICON_REGISTRY = {
  archive: ArchiveIcon,
  'arrow-bend-down-left': ArrowBendDownLeftIcon,
  'arrow-clockwise': ArrowClockwiseIcon,
  'arrow-down': ArrowDownIcon,
  'arrow-left': ArrowLeftIcon,
  'arrow-right': ArrowRightIcon,
  'arrow-square-out': ArrowSquareOutIcon,
  'arrow-up': ArrowUpIcon,
  'arrows-clockwise': ArrowsClockwiseIcon,
  brain: BrainIcon,
  'caret-down': CaretDownIcon,
  'caret-left': CaretLeftIcon,
  'caret-right': CaretRightIcon,
  'caret-up': CaretUpIcon,
  'caret-up-down': CaretUpDownIcon,
  check: CheckIcon,
  'check-circle': CheckCircleIcon,
  circle: CircleIcon,
  'circle-notch': CircleNotchIcon,
  code: CodeIcon,
  command: CommandIcon,
  copy: CopyIcon,
  cpu: CpuIcon,
  desktop: DesktopIcon,
  'dots-three': DotsThreeIcon,
  eye: EyeIcon,
  'eye-slash': EyeSlashIcon,
  file: FileIcon,
  'file-code': FileCodeIcon,
  'file-text': FileTextIcon,
  folder: FolderSimpleIcon,
  'folder-open': FolderOpenIcon,
  'folder-plus': FolderPlusIcon,
  gear: GearSixIcon,
  'git-branch': GitBranchIcon,
  'git-diff': GitDiffIcon,
  globe: GlobeIcon,
  hand: HandIcon,
  image: ImageSquareIcon,
  info: InfoIcon,
  lightbulb: LightbulbIcon,
  'list-checks': ListChecksIcon,
  'magnifying-glass': MagnifyingGlassIcon,
  'minus-circle': MinusCircleIcon,
  moon: MoonIcon,
  'note-pencil': NotePencilIcon,
  package: PackageIcon,
  palette: PaletteIcon,
  pencil: PencilSimpleIcon,
  'pencil-line': PencilLineIcon,
  play: PlayIcon,
  'plugs-connected': PlugsConnectedIcon,
  plus: PlusIcon,
  pulse: PulseIcon,
  'push-pin': PushPinIcon,
  'push-pin-slash': PushPinSlashIcon,
  'shield-check': ShieldCheckIcon,
  'shield-warning': ShieldWarningIcon,
  shuffle: ShuffleIcon,
  sidebar: SidebarSimpleIcon,
  sliders: SlidersHorizontalIcon,
  sparkle: SparkleIcon,
  spinner: SpinnerGapIcon,
  'split-horizontal': SplitHorizontalIcon,
  'squares-four': SquaresFourIcon,
  stop: StopIcon,
  sun: SunIcon,
  terminal: TerminalWindowIcon,
  trash: TrashIcon,
  warning: WarningIcon,
  'warning-circle': WarningCircleIcon,
  x: XIcon,
  'x-circle': XCircleIcon,
} as const satisfies Record<string, PhosphorIconComponent>;

/** Kapibala UI 2.0 标准图标名称联合类型。 */
export type IconName = keyof typeof ICON_REGISTRY;

/**
 * `Icon` 组件入参契约：默认作为纯装饰矢量隐藏于可访问树（`aria-hidden="true"`）；
 * 仅当显式传入 `label` 时暴露 `role="img"`，防止按钮或列表行内读屏器重复朗读图标名。
 */
export interface IconProps {
  readonly name: IconName;
  readonly size?: number;
  readonly weight?: IconWeight;
  readonly label?: string;
  readonly className?: string;
}

/**
 * 全应用 UI 图标唯一出口：封装 `@phosphor-icons/react`（默认 `16px` `regular`），
 * 替代旧版常驻 `requestAnimationFrame` 动态图标引擎，保障空闲帧 CPU 零占用。
 */
export function Icon({ name, size = 16, weight = 'regular', label, className }: IconProps) {
  const Glyph = ICON_REGISTRY[name];
  if (label) {
    return (
      <Glyph
        size={size}
        weight={weight}
        role="img"
        aria-label={label}
        aria-hidden={false}
        className={className}
      />
    );
  }
  return <Glyph size={size} weight={weight} aria-hidden="true" className={className} />;
}

/**
 * `BrandMark` 入参契约：仅限左栏顶带、Launchpad 启动台与关于页使用，
 * 默认装饰态不干扰相邻「Kapibala」字标朗读，独立展示时可设 `decorative={false}`。
 */
export interface BrandMarkProps {
  readonly size?: number;
  readonly decorative?: boolean;
  readonly label?: string;
  readonly className?: string;
}

/**
 * Kapibala 极简墨线品牌标识（Atelier Monoline，源自 `assets/capybara.svg` 单一几何真源）：
 * 墨线绑定 `--kpbl-ink-strong`、头顶小橘绑定 `--kpbl-pulse`，随浅/深主题自动切换且零硬编码色值。
 */
export function BrandMark({
  size = 20,
  decorative = true,
  label = 'Kapibala',
  className,
}: BrandMarkProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      width={size}
      height={size}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative ? 'true' : undefined}
      className={className}
    >
      {!decorative && <title>{label}</title>}
      <circle cx="330" cy="59" r="40.5" fill="var(--kpbl-pulse)" />
      <g
        fill="none"
        stroke="var(--kpbl-ink-strong)"
        strokeWidth="23"
        strokeLinecap="round"
        strokeLinejoin="miter"
        strokeMiterlimit="6"
      >
        <path d="M 234 173 A 30 30 0 1 1 256 145" />
        <path d="M 278 137 H 430 A 51 51 0 0 1 481 188 V 253 A 51 51 0 0 1 430 304 H 377 A 51 51 0 0 0 326 355 V 481 H 150 A 119 119 0 0 1 31 362 V 356 A 146 146 0 0 1 177 210 H 190 A 34 34 0 0 0 216 198 L 252 150 A 34 34 0 0 1 278 137 Z" />
        <line x1="309" y1="185.5" x2="351" y2="185.5" strokeWidth="22" />
      </g>
    </svg>
  );
}
