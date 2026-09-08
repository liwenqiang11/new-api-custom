export type ManualUpdatePlatform = 'darwin' | 'linux';

export interface GitHubRelease {
  tag_name: string;
  name: string | null;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
}

export interface UpdaterJson {
  version: string;
  notes?: string;
  pub_date?: string;
  url?: string;
}

export interface PackageJsonVersion {
  version: string;
}

export interface ManualUpdateInfo {
  version: string;
  tagName: string;
  releaseName: string;
  releaseUrl: string;
  platform: ManualUpdatePlatform;
}

export interface ManualUpdateSnooze {
  version: string;
  dismissedAt: string;
}

export type ManualUpdateCheckResult =
  | {
      status: 'available';
      update: ManualUpdateInfo;
    }
  | {
      status: 'up-to-date';
    }
  | {
      status: 'unsupported';
    }
  | {
      status: 'error';
      message: string;
    };
