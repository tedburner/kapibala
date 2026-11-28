import { useEffect, useMemo, useState } from 'react';
import type { Output } from '../../../shared/contracts.js';
import type { PreferredShellPreference } from '../../../shared/i18n/index.js';
import { useI18n } from '../../i18n.js';
import {
  Badge,
  Button,
  MiddleTruncate,
  Select,
  type SelectOption,
  SettingRow,
  SettingSection,
} from '../../ui/index.js';
import {
  copyTextSafe,
  describeUpdateDownloadFailure,
  formatByteSize,
  withSettingsWatchdog,
} from './settings-helpers.js';

const MACOS_XATTR_COMMAND = 'xattr -cr /Applications/Kapibala.app';

function buildShellOptions(
  platform: string | undefined,
  locale: 'zh-CN' | 'en',
): readonly SelectOption<PreferredShellPreference>[] {
  const autoLabel = locale === 'en' ? 'Auto Detect (Recommended)' : '自动检测（推荐）';
  if (platform === 'win32') {
    return [
      { value: 'auto', label: autoLabel },
      { value: 'pwsh', label: 'PowerShell 7 (pwsh)' },
      { value: 'powershell', label: 'Windows PowerShell' },
      { value: 'cmd', label: 'Command Prompt (cmd.exe)' },
      { value: 'git-bash', label: 'Git Bash' },
    ];
  }
  return [
    { value: 'auto', label: autoLabel },
    { value: 'zsh', label: 'Zsh (/bin/zsh)' },
    { value: 'bash', label: 'Bash (/bin/bash)' },
    { value: 'fish', label: 'Fish' },
    { value: 'sh', label: 'POSIX sh (/bin/sh)' },
  ];
}

/**
 * `GeneralUpdatesSection` 入参契约：
 * 承载「常规」页底部的交互式终端 Shell 选择与未签名 GitHub Releases 手动更新检查/SHA-256 校验下载。
 */
export interface GeneralUpdatesSectionProps {
  readonly active?: boolean;
  readonly appInfo?: Output<'app.getInfo'>;
  readonly preferredShell: PreferredShellPreference;
  readonly onPreferredShellChange: (shell: PreferredShellPreference) => void;
  readonly initialUpdateCheck?: Output<'app.checkUpdate'>;
}

/**
 * 「常规」页终端环境与版本更新分组。
 */
export function GeneralUpdatesSection({
  active = true,
  appInfo: propInfo,
  preferredShell,
  onPreferredShellChange,
  initialUpdateCheck,
}: GeneralUpdatesSectionProps) {
  const { locale, t } = useI18n();
  const [info, setInfo] = useState<Output<'app.getInfo'> | undefined>(propInfo);
  const [updateCheck, setUpdateCheck] = useState<Output<'app.checkUpdate'> | undefined>(
    initialUpdateCheck,
  );
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateError, setUpdateError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{
    readonly downloaded: number;
    readonly total: number;
  }>();
  const [downloadResult, setDownloadResult] = useState<Output<'app.downloadUpdate'>>();
  const [copiedXattr, setCopiedXattr] = useState(false);

  const shellOptions = useMemo(
    () => buildShellOptions(info?.platform, locale),
    [info?.platform, locale],
  );

  useEffect(() => {
    if (propInfo) setInfo(propInfo);
  }, [propInfo]);

  useEffect(() => {
    if (!active || typeof window === 'undefined' || !window.kapibala) return undefined;
    if (!propInfo) {
      void window.kapibala.app
        .getInfo()
        .then(setInfo)
        .catch(() => {});
    }
    return window.kapibala.onEvent((event) => {
      if (event.type === 'update.downloadProgress') {
        setDownloadProgress({ downloaded: event.downloaded, total: event.total });
      }
    });
  }, [active, propInfo]);

  function handleCheckUpdate(): void {
    if (updateBusy || typeof window === 'undefined' || !window.kapibala) return;
    setUpdateBusy(true);
    setUpdateError('');
    void withSettingsWatchdog(window.kapibala.app.checkUpdate(), '检查更新超时', 20_000)
      .then(setUpdateCheck)
      .catch((err: unknown) =>
        setUpdateError(err instanceof Error ? err.message : '检查更新失败。'),
      )
      .finally(() => setUpdateBusy(false));
  }

  function handleDownloadUpdate(): void {
    if (downloading || typeof window === 'undefined' || !window.kapibala) return;
    setDownloading(true);
    setUpdateError('');
    setDownloadResult(undefined);
    setDownloadProgress(undefined);
    void window.kapibala.app
      .downloadUpdate()
      .then(setDownloadResult)
      .catch((err: unknown) =>
        setUpdateError(err instanceof Error ? err.message : '下载更新失败。'),
      )
      .finally(() => {
        setDownloading(false);
        setDownloadProgress(undefined);
      });
  }

  return (
    <SettingSection
      title={t('general.terminalSection')}
      description={t('general.terminalSectionDesc')}
      actions={
        <span className="kpbl-row-title-line">
          <Badge>{info ? `Kapibala v${info.version}` : 'Kapibala'}</Badge>
          {info?.testBuild ? (
            <Badge tone="warning">{locale === 'en' ? 'Test Build' : '内部测试构建'}</Badge>
          ) : null}
        </span>
      }
    >
      <SettingRow
        title={t('general.shellLabel')}
        description={t('general.shellDesc')}
        control={
          <Select<PreferredShellPreference>
            aria-label={t('general.shellLabel')}
            size="sm"
            value={preferredShell}
            options={shellOptions}
            onValueChange={onPreferredShellChange}
          />
        }
      />

      <SettingRow
        title={locale === 'en' ? 'GitHub Releases Update Check' : 'GitHub Releases 更新检查'}
        description={
          locale === 'en'
            ? 'Manual check only; downloads verify SHA-256 before opening the installer.'
            : '不后台轮询、不静默替换运行中程序；校验通过后打开系统下载目录由你手动安装。'
        }
        control={
          <>
            {updateCheck?.releaseUrl ? (
              <Button
                variant="ghost"
                size="sm"
                trailingIcon="arrow-square-out"
                onClick={() => {
                  if (updateCheck.releaseUrl && typeof window !== 'undefined') {
                    void window.kapibala?.app.openExternal(updateCheck.releaseUrl);
                  }
                }}
              >
                {locale === 'en' ? 'Release Page' : '打开发布页'}
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              leadingIcon="arrows-clockwise"
              loading={updateBusy}
              onClick={handleCheckUpdate}
            >
              {updateBusy
                ? locale === 'en'
                  ? 'Checking…'
                  : '检查中…'
                : locale === 'en'
                  ? 'Check Updates'
                  : '检查更新'}
            </Button>
          </>
        }
      >
        {updateError ? (
          <p role="alert" className="kpbl-field-error">
            {updateError}
          </p>
        ) : null}

        {updateCheck?.status === 'up-to-date' ? (
          <p className="kpbl-field-hint">
            {locale === 'en'
              ? `Up to date (${updateCheck.latestVersion}).`
              : `已是最新版本（${updateCheck.latestVersion}）。`}
          </p>
        ) : null}

        {updateCheck?.status === 'no-asset' ? (
          <p className="kpbl-field-hint">
            {locale === 'en'
              ? `Release ${updateCheck.latestVersion} has no prebuilt asset for this platform.`
              : `最新版本 ${updateCheck.latestVersion} 暂无匹配当前平台架构的安装包，请前往发布页查看。`}
          </p>
        ) : null}

        {updateCheck?.status === 'unknown' ? (
          <p className="kpbl-field-hint">
            {locale === 'en'
              ? `Unable to reach update feed (${updateCheck.reason ?? 'UNKNOWN'}).`
              : `暂时无法连接更新源（${updateCheck.reason ?? 'UNKNOWN'}），不影响离线与日常使用。`}
          </p>
        ) : null}

        {updateCheck?.status === 'update-available' ? (
          <div className="kpbl-dialog-stack">
            <div className="kpbl-row-title-line kpbl-tabular">
              <span className="kpbl-setting-row-title">
                {locale === 'en'
                  ? `New version ${updateCheck.latestVersion} available (current ${updateCheck.currentVersion})`
                  : `发现新版本 ${updateCheck.latestVersion}（当前 ${updateCheck.currentVersion}）`}
              </span>
              {updateCheck.installer ? (
                <Badge outline>
                  {updateCheck.installer.name} · {formatByteSize(updateCheck.installer.size)}
                </Badge>
              ) : null}
            </div>

            <div className="kpbl-row-title-line kpbl-tabular">
              {downloading ? (
                <>
                  <span className="kpbl-field-hint">
                    {downloadProgress
                      ? `正在下载并校验 SHA-256：${formatByteSize(downloadProgress.downloaded)}${
                          downloadProgress.total > 0
                            ? ` / ${formatByteSize(downloadProgress.total)}`
                            : ''
                        }`
                      : '正在下载安装包…'}
                  </span>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      void window.kapibala?.app.cancelUpdateDownload().catch(() => {});
                    }}
                  >
                    {locale === 'en' ? 'Cancel' : '取消下载'}
                  </Button>
                </>
              ) : (
                <Button variant="solid" size="xs" onClick={handleDownloadUpdate}>
                  {downloadResult?.status === 'failed'
                    ? locale === 'en'
                      ? 'Retry Download'
                      : '重试下载'
                    : locale === 'en'
                      ? 'Download Installer'
                      : '下载安装包'}
                </Button>
              )}
            </div>

            {downloadResult?.status === 'downloaded' ? (
              <p className="kpbl-field-hint">
                已通过 SHA-256 完整性校验，
                {downloadResult.opened ? '已唤起安装包：' : '请前往下载目录手动安装：'}
                <MiddleTruncate mono maxChars={52} text={downloadResult.filePath} />
              </p>
            ) : null}

            {downloadResult?.status === 'cancelled' ? (
              <p className="kpbl-field-hint">已取消下载并清理未完成临时文件。</p>
            ) : null}

            {downloadResult?.status === 'failed' ? (
              <p role="alert" className="kpbl-field-error">
                {describeUpdateDownloadFailure(downloadResult.reason, downloadResult.detail)}
              </p>
            ) : null}
          </div>
        ) : null}
      </SettingRow>

      <SettingRow
        align="start"
        title={locale === 'en' ? 'macOS Gatekeeper Note' : '手动安装与 macOS 未签名放行说明'}
        description={
          locale === 'en'
            ? 'Quit Kapibala before replacing the app; on macOS remove quarantine xattr if prompted:'
            : '覆盖安装前请先退出正在运行的 Kapibala；macOS 若首次启动提示「已损坏或无法验证开发者」，可在终端移除隔离扩展属性：'
        }
        control={
          <Button
            variant="ghost"
            size="xs"
            leadingIcon="copy"
            onClick={() => {
              void copyTextSafe(MACOS_XATTR_COMMAND).then((ok) => {
                if (ok) setCopiedXattr(true);
              });
            }}
          >
            {copiedXattr
              ? locale === 'en'
                ? 'Copied'
                : '已复制'
              : locale === 'en'
                ? 'Copy Command'
                : '复制命令'}
          </Button>
        }
      >
        <code className="kpbl-dialog-mono-box">{MACOS_XATTR_COMMAND}</code>
      </SettingRow>
    </SettingSection>
  );
}
