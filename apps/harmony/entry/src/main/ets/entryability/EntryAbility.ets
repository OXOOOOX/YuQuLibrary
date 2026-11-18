import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { PlaybackService } from '../services/PlaybackService';
import { ConnectionProbe } from '../services/ConnectionProbe';
import { AccountSync } from '../services/AccountSync';

export default class EntryAbility extends UIAbility {
  onCreate(_want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    // The service belongs to the ability, not to a page that can disappear.
    void PlaybackService.getInstance().initialize(this.context);
    void AccountSync.getInstance().initialize();
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (error: BusinessError) => {
      if (error.code) {
        hilog.error(0x1000, 'YuQuPlayback', 'Page load failed: %{public}s', error.message);
      }
    });
  }

  onForeground(): void {
    PlaybackService.getInstance().setForeground(true);
    ConnectionProbe.getInstance().setForeground(true);
    AccountSync.getInstance().setForeground(true);
  }

  onBackground(): void {
    PlaybackService.getInstance().setForeground(false);
    ConnectionProbe.getInstance().setForeground(false);
    AccountSync.getInstance().setForeground(false);
  }

  onDestroy(): void {
    ConnectionProbe.getInstance().release();
    AccountSync.getInstance().release();
    void PlaybackService.getInstance().release();
  }
}
