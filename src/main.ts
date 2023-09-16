import {
  App,
  ButtonComponent,
  DataAdapter,
  debounce,
  Editor,
  MarkdownView,
  Modal,
  normalizePath,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  Vault
} from 'obsidian';
import {StatusBar} from "./status";
import SystemInfo from "./system";
import ReactPlayer from 'react-player/lazy'
import Dict = NodeJS.Dict;

import { VideoView, VIDEO_VIEW } from '../view/VideoView';
const { setTimeout: setTimeoutPromiseBased } = require('timers/promises');

// the process.env variable will be replaced by its target value in the output main.js file
const baseURL = process.env.RECLIPPED_SERVER_URL || "https://reclipped.com";
const ERRORS: { [key: string]: string } = {
  "INVALID_URL": "\n> [!error] Invalid Video URL\n> The highlighted link is not a valid video url. Please try again with a valid link.\n",
  "NO_ACTIVE_VIDEO": "\n> [!caution] Select Video\n> A video needs to be opened before using this hotkey.\n Highlight your video link and input your 'Open video player' hotkey to register a video.\n",
}

interface ReclippedAuthResponse {
  userAccessToken: string;
}

interface ExportRequestResponse {
  last_synced_epoch: number,
  video_ids: Array<string>;
  status: string;
}

interface platformDict {
  "baseurl": string,
  "platform": string,
  "id": string,
  "embedurl": string,
  "platformPath": string
}

interface channelDict {
  "channelName": string,
  "channelLink": string,
  "channelPath": string
}

interface markdownResponseJson {
  "platform": platformDict,
  "status": string,
  "channel": channelDict,
  "annotations": string,
  "title": string,
  "vidUrl": string
}

interface ReclippedPluginSettings {
  token: string;
  reclippedDir: string;
  isSyncing: boolean;
  frequency: string;
  triggerOnLoad: boolean;
  lastSyncFailed: boolean;
  lastSyncedTimeEpoch: number;
  refreshVideos: boolean,
  videosToRefresh: Array<string>;
  videosIDsMap: { [key: string]: string; };
  videoIDUrlMap: { [key:string]: string };
  reimportShowConfirmation: boolean;
  urlColor: string;
  timestampColor: string;
  urlTextColor: string;
  timestampTextColor: string;
  urlStartTimeMap: Map<string, number>;
}

// define our initial settings
const DEFAULT_SETTINGS: ReclippedPluginSettings = {
  token: "",
  reclippedDir: "ReClipped",
  frequency: "0", // manual by default
  triggerOnLoad: true,
  isSyncing: false,
  lastSyncFailed: false,
  lastSyncedTimeEpoch: 0,
  refreshVideos: false,
  videosToRefresh: [],
  videosIDsMap: {},
  videoIDUrlMap: {},
  reimportShowConfirmation: true,
  urlColor: 'blue',
  timestampColor: 'green',
  urlTextColor: 'white',
  timestampTextColor: 'white',
  urlStartTimeMap: new Map<string, number>(),
};

export default class ReclippedPlugin extends Plugin {
  settings: ReclippedPluginSettings;
  fs: DataAdapter;
  vault: Vault;
  scheduleInterval: null | number = null;
  statusBar: StatusBar;
  player: ReactPlayer;
  setPlaying: React.Dispatch<React.SetStateAction<boolean>>;
  editor: Editor;
  currentlyPlaying = "";

  getErrorMessageFromResponse(response: Response) {
    if (response && response.status === 409) {
      return "Sync in progress initiated by different client";
    }
    if (response && response.status === 417) {
      return "Obsidian export is locked. Wait for an hour.";
    }
    return `${response ? response.statusText : "Can't connect to server"}`;
  }

  handleSyncError(buttonContext: ButtonComponent, msg: string) {
    this.clearSettingsAfterRun();
    this.settings.lastSyncFailed = true;
    this.saveSettings();
    if (buttonContext) {
      this.showInfoStatus(buttonContext.buttonEl.parentElement, msg, "rw-error");
      buttonContext.buttonEl.setText("Run sync");
    } else {
      this.notice(msg, true, 4, true);
    }
  }

  clearSettingsAfterRun() {
    this.settings.isSyncing = false;
  }

  handleSyncSuccess(buttonContext: ButtonComponent, msg: string = "Synced", exportID: number = null) {
    this.clearSettingsAfterRun();
    this.settings.lastSyncFailed = false;
    if (exportID) {
      this.settings.lastSyncedTimeEpoch = exportID;
    }
    this.saveSettings();
    // if we have a button context, update the text on it
    // this is the case if we fired on a "Run sync" click (the button)
    if (buttonContext) {
      this.showInfoStatus(buttonContext.buttonEl.parentNode.parentElement, msg, "rw-success");
      buttonContext.buttonEl.setText("Run sync");
    }
  }

  async requestArchive(buttonContext?: ButtonComponent, auto?: boolean) {

    const parentDeleted = !await this.app.vault.adapter.exists(this.settings.reclippedDir);

    let url = `${baseURL}/api/markdown/videos?all=${parentDeleted}`;
    let syncUpTo = this.settings.lastSyncedTimeEpoch;
    url += `&syncUpTo=${syncUpTo}`;
    if (auto) {
      url += `&auto=${auto}`;
    }
    let response, data: ExportRequestResponse;
    try {
      response = await fetch(
        url,
        {
          headers: this.getAuthHeaders()
        }
      );
    } catch (e) {
      console.log("ReClipped Official plugin: fetch failed in requestArchive: ", e);
    }
    if (response && response.ok) {
      data = await response.json();
      if (data.video_ids.length <= 0) {
        this.handleSyncSuccess(buttonContext);
        this.notice("ReClipped data is already up to date", false, 4, true);
        return;
      }
      this.settings.lastSyncedTimeEpoch = data.last_synced_epoch;
      await this.saveSettings();
      this.notice("Syncing ReClipped data");
      return this.downloadAnnotations(data.last_synced_epoch, data.video_ids, buttonContext);
    } else {
      console.log("ReClipped Official plugin: bad response in requestArchive: ", response);
      this.handleSyncError(buttonContext, this.getErrorMessageFromResponse(response));
      return;
    }
  }

  notice(msg: string, show = false, timeout = 0, forcing: boolean = false) {
    if (show) {
      new Notice(msg);
    }
    // @ts-ignore
    if (!this.app.isMobile) {
      this.statusBar.displayMessage(msg.toLowerCase(), timeout, forcing);
    } else {
      if (!show) {
        new Notice(msg);
      }
    }
  }

  showInfoStatus(container: HTMLElement, msg: string, className = "") {
    let info = container.find('.rw-info-container');
    info.setText(msg);
    info.addClass(className);
  }

  clearInfoStatus(container: HTMLElement) {
    let info = container.find('.rw-info-container');
    info.empty();
  }

  getAuthHeaders() {
    return {
      'Authorization': `Bearer ${this.settings.token}`,
      'Obsidian-Client-Id': `${this.getObsidianClientID()}`,
    };
  }

  isEmpty(obj:Dict<any>) : Boolean {
    return Object.keys(obj).length === 0;
  }

  async ensureDirectoryExists(processedFileName:string){
    let dirPath = processedFileName.replace(/\/*$/, '').replace(/^(.+)\/[^\/]*?$/, '$1');
    const exists = await this.fs.exists(dirPath);
    if (!exists) {
      await this.fs.mkdir(dirPath);
    }
  }

  async createChannelPlatformConnections(channelDict: channelDict, platformDict: platformDict, fs: DataAdapter): Promise<void> {
    if (!this.isEmpty(platformDict)) {
      let platformNameFile = platformDict.platformPath + '.md'
      await this.ensureDirectoryExists(platformNameFile);
      const platformPageExists = await fs.exists(platformNameFile);
      if (!platformPageExists) {
        let platformContents = "["+platformDict.platform+"]("+platformDict.baseurl+") \n";
        await fs.write(platformNameFile, platformContents);
      }
    }
    if (!this.isEmpty(channelDict) && platformDict.baseurl != channelDict.channelLink) {
      let channelNameFile = channelDict.channelPath + '.md'
      await this.ensureDirectoryExists(channelNameFile);
      const channelPageExists = await fs.exists(channelNameFile);
      if (!channelPageExists) {
        let contents = "Visit ["+channelDict.channelName+"]("+channelDict.channelLink+") on [["+ platformDict.platform +"]] \n";
        await fs.write(channelNameFile, contents);
      }
    }
  }

  async downloadAnnotations(syncUpTo: number, videoIds:Array<string>, buttonContext: ButtonComponent): Promise<void> {
    let downloadURL = `${baseURL}/api/download/markdown?video_id=`;
    let response, json:markdownResponseJson;
    let videoCount = 1;
    this.fs = this.app.vault.adapter;
    // ensure the directory exists
    let dirPath = this.settings.reclippedDir;
    const exists = await this.fs.exists(dirPath);
    if (!exists) {
      await this.fs.mkdir(dirPath);
    }
    for (const vidId of videoIds){
      const progressMsg = `Exporting ReClipped data (${videoCount} / ${videoIds.length}) ...`;
      this.notice(progressMsg);
      videoCount = videoCount + 1;
      try {
        response = await fetch(
            downloadURL + vidId, {headers: this.getAuthHeaders()}
        );
      } catch (e) {
        console.log("ReClipped Official plugin: fetch failed in download video annotations: ", e);
      }
      if (response && response.ok) {
        json = await response.json();
        if (this.isEmpty(json)){
          continue;
        }
        let cleanedFileName = json.title;
        let channelDict = json.channel;
        let platform = json.platform;
        this.notice(`Saving file ${cleanedFileName}`, false, 30);
        const processedFileName = normalizePath(this.settings.reclippedDir + '/' + cleanedFileName + '.md');
        try {
          await this.createChannelPlatformConnections(channelDict, platform, this.fs);
          // write the actual files
          const contentToSave = json.annotations;
          let originalName = processedFileName;
          // extracting video id = title
          this.settings.videosIDsMap[originalName] = vidId;
          this.settings.videoIDUrlMap[vidId] = json.vidUrl;
          await this.fs.write(originalName, contentToSave);
          let videosToRefresh = this.settings.videosToRefresh;
          this.settings.videosToRefresh = videosToRefresh.filter(n => n!=vidId);
          await this.saveSettings();
        } catch (e) {
          console.log(`ReClipped Official plugin: error writing ${processedFileName}:`, e);
          this.notice(`ReClipped: error while writing ${processedFileName}: ${e}`, true, 4, true);
          if (vidId) {
            this.settings.videosToRefresh.push(vidId);
            await this.saveSettings();
          }
        }
      } else {
        console.log("ReClipped Official plugin: bad response in downloadAnnotations: ", response);
        this.handleSyncError(buttonContext, this.getErrorMessageFromResponse(response));
        return;
      }
      await setTimeoutPromiseBased(10);
    }

    await this.acknowledgeSyncCompleted(buttonContext);
    this.handleSyncSuccess(buttonContext, "Synced!", syncUpTo);
    this.notice("ReClipped sync completed", true, 1, true);
    // @ts-ignore
    if (this.app.isMobile) {
      this.notice("If you don't see all of your reclipped files reload obsidian app", true,);
    }
    return;
  }

  async acknowledgeSyncCompleted(buttonContext: ButtonComponent) {
    let response;
    try {
      response = await fetch(
        `${baseURL}/api/obsidian/sync_ack`,
        {
          headers: {...this.getAuthHeaders(), 'Content-Type': 'application/json'},
          method: "POST",
        });
    } catch (e) {
      console.log("ReClipped Official plugin: fetch failed to acknowledged sync: ", e);
    }
    if (response && response.ok) {
      return;
    } else {
      console.log("ReClipped Official plugin: bad response in acknowledge sync: ", response);
      this.handleSyncError(buttonContext, this.getErrorMessageFromResponse(response));
      return;
    }
  }

  async configureSchedule() {
    const minutes = parseInt(this.settings.frequency);
    let milliseconds = minutes * 60 * 1000; // minutes * seconds * milliseconds
    console.log('ReClipped Official plugin: setting interval to ', milliseconds, 'milliseconds');
    window.clearInterval(this.scheduleInterval);
    this.scheduleInterval = null;
    if (!milliseconds) {
      // we got manual option
      return;
    }
    this.scheduleInterval = window.setInterval(() => this.requestArchive(null, true), milliseconds);
    this.registerInterval(this.scheduleInterval);
  }

  refreshDocumentExport(videoIds?: Array<string>) {
    videoIds = videoIds || this.settings.videosToRefresh;
    if (!videoIds.length || !this.settings.refreshVideos) {
      return;
    }
    try {
      this.downloadAnnotations(null, videoIds, null).then(() => {
        return;
      });
    } catch (e) {
      console.log("ReClipped Official plugin: fetch failed in refreshDocumentExport: ", e);
    }
  }

  async addVideoToRefresh(videoId: string) {
    let videosToRefresh = this.settings.videosToRefresh;
    videosToRefresh.push(videoId);
    this.settings.videosToRefresh = videosToRefresh;
    await this.saveSettings();
  }

  reimportFile(vault: Vault, fileName: string) {
    const videoId = this.settings.videosIDsMap[fileName];
    try {
      this.downloadAnnotations(null, [videoId], null).then(() => {
        return;
      });
    } catch (e) {
      console.log("ReClipped Official plugin: fetch failed in Reimport current file: ", e);
    }
  }

  startSync() {
    if (this.settings.isSyncing) {
      this.notice("ReClipped sync already in progress", true);
    } else {
      this.settings.isSyncing = true;
      this.saveSettings();
      this.requestArchive();
    }
    console.log("started sync");
  }

  async onload() {
    this.registerView(
        VIDEO_VIEW,
        (leaf) => new VideoView(leaf)
    );

    // @ts-ignore
    if (!this.app.isMobile) {
      this.statusBar = new StatusBar(this.addStatusBarItem());
      this.registerInterval(
        window.setInterval(() => this.statusBar.display(), 1000)
      );
    }

    await this.loadSettings();
    this.refreshDocumentExport = debounce(
      this.refreshDocumentExport.bind(this),
      800,
      true
    );

    this.refreshDocumentExport(this.settings.videosToRefresh);

    this.app.vault.on("delete", async (file) => {
      const videoId = this.settings.videosIDsMap[file.path];
      if (videoId) {
        await this.addVideoToRefresh(videoId);
      }
      this.refreshDocumentExport();
      delete this.settings.videosIDsMap[file.path];
      this.saveSettings();
    });

    this.app.vault.on("rename", (file, oldPath) => {
      const videoId = this.settings.videosIDsMap[oldPath];
      if (!videoId) {
        return;
      }
      this.settings.videosIDsMap[file.path] = videoId;
      delete this.settings.videosIDsMap[oldPath];
      this.saveSettings();
    });

    if (this.settings.isSyncing) {
        // we probably got some unhandled error...
        this.settings.isSyncing = false;
        await this.saveSettings();
    }

    this.addCommand({
      id: 'reclipped-official-sync',
      name: 'Sync your data now',
      callback: () => {
        this.startSync();
      }
    });

    // this.addCommand({
    //   id: 'reclipped-official-format',
    //   name: 'Customize formatting',
    //   callback: () => window.open(`${baseURL}/export/obsidian/preferences`)
    // });

    this.addCommand({
      id: 'reclipped-official-reimport-file',
      name: 'Delete and reimport this document',
      editorCheckCallback: (checking: boolean, editor: Editor, view: MarkdownView) => {
        const activeFilePath = view.file.path;
        const isRWfile = activeFilePath in this.settings.videosIDsMap;
        if (checking) {
          return isRWfile;
        }
        if (this.settings.reimportShowConfirmation) {
          const modal = new Modal(view.app);
          modal.contentEl.createEl(
            'p',
            {
              'text': 'Warning: Proceeding will delete this file entirely (including any changes you made) ' +
                'and then reimport a new copy of your annotations from ReClipped.'
            });
          const buttonsContainer = modal.contentEl.createEl('div', {"cls": "rw-modal-btns"});
          const cancelBtn = buttonsContainer.createEl("button", {"text": "Cancel"});
          const confirmBtn = buttonsContainer.createEl("button", {"text": "Proceed", 'cls': 'mod-warning'});
          const showConfContainer = modal.contentEl.createEl('div', {'cls': 'rw-modal-confirmation'});
          showConfContainer.createEl("label", {"attr": {"for": "rw-ask-nl"}, "text": "Don't ask me in the future"});
          const showConf = showConfContainer.createEl("input", {"type": "checkbox", "attr": {"name": "rw-ask-nl"}});
          showConf.addEventListener('change', (ev) => {
            // @ts-ignore
            this.settings.reimportShowConfirmation = !ev.target.checked;
            this.saveSettings();
          });
          cancelBtn.onClickEvent(() => {
            modal.close();
          });
          confirmBtn.onClickEvent(() => {
            this.reimportFile(view.app.vault, activeFilePath);
            modal.close();
          });
          modal.open();
        } else {
          this.reimportFile(view.app.vault, activeFilePath);
        }
      }
    });

    this.registerMarkdownPostProcessor((el, ctx) => {
      if (!ctx.sourcePath.startsWith(this.settings.reclippedDir)) {
        return;
      }
      let matches: string[];
      try {
        // @ts-ignore
        matches = [...ctx.getSectionInfo(el).text.matchAll(/__(.+)__/g)].map((a) => a[1]);
      } catch (TypeError) {
        // failed interaction with a Dataview element
        return;
      }
      const hypers = el.findAll("strong").filter(e => matches.contains(e.textContent));
      hypers.forEach(strongEl => {
        const replacement = el.createEl('span');
        while (strongEl.firstChild) {
          replacement.appendChild(strongEl.firstChild);
        }
        replacement.addClass("rw-hyper-highlight");
        strongEl.replaceWith(replacement);
      });
    });

    this.addSettingTab(new ReclippedSettingTab(this.app, this));

    await this.configureSchedule();

    if (this.settings.token && this.settings.triggerOnLoad && !this.settings.isSyncing) {
      await this.saveSettings();
      await this.requestArchive(null, true);
    }

    // Markdown processor that turns timestamps into buttons
    this.registerMarkdownCodeBlockProcessor("timestamp", (source, el, ctx) => {
      // Match mm:ss or hh:mm:ss timestamp format
      const regExp = /\d+:\d+:\d+|\d+:\d+/g;
      const rows = source.split("\n").filter((row) => row.length > 0);
      rows.forEach((row) => {
        const match = row.match(regExp);
        if (match) {
          //create button for each timestamp
          const div = el.createEl("div");
          const button = div.createEl("button");
          button.innerText = match[0];
          button.style.backgroundColor = this.settings.timestampColor;
          button.style.color = this.settings.timestampTextColor;

          // convert timestamp to seconds and seek to that position when clicked
          button.addEventListener("click", () => {
            const timeArr = match[0].split(":").map((v) => parseInt(v));
            const [hh, mm, ss] = timeArr.length === 2 ? [0, ...timeArr] : timeArr;
            const seconds = (hh || 0) * 3600 + (mm || 0) * 60 + (ss || 0);
            if (this.player) this.player.seekTo(seconds);
          });
          div.appendChild(button);
        }
      })
    });


    // Markdown processor that turns video urls into buttons to open views of the video
    this.registerMarkdownCodeBlockProcessor("timestamp-url", (source, el, ctx) => {
      const url = source.trim();
      if (ReactPlayer.canPlay(url)) {
        // Creates button for video url
        const div = el.createEl("div");
        const button = div.createEl("button");
        button.innerText = url;
        button.style.backgroundColor = this.settings.urlColor;
        button.style.color = this.settings.urlTextColor;

        button.addEventListener("click", () => {
          this.activateView(url, this.editor);
        });
      } else {
        if (this.editor) {
          this.editor.replaceSelection(this.editor.getSelection() + "\n" + ERRORS["INVALID_URL"]);
        }
      }
    });

    this.app.workspace.on("file-open", (file) => {
      const videoId = this.settings.videosIDsMap[file.path];
      if (videoId) {
        const vidUrl = this.settings.videoIDUrlMap[videoId]
        if (vidUrl) {
          if (this.currentlyPlaying!= vidUrl) {
            this.activateView(vidUrl, this.editor);
            this.currentlyPlaying = vidUrl;
          }
        } else {
          this.deactivateView();
        }
      }
    });
  }

  onunload() {
    this.player = null;
    this.editor = null;
    this.setPlaying = null;
    this.app.workspace.detachLeavesOfType(VIDEO_VIEW);
    return;
  }

  async deactivateView() {
    this.app.workspace.detachLeavesOfType(VIDEO_VIEW);
  }

  async activateView(url: string, editor: Editor) {
    this.app.workspace.detachLeavesOfType(VIDEO_VIEW);

    await this.app.workspace.getRightLeaf(false).setViewState({
      type: VIDEO_VIEW,
      active: true,
    });

    this.app.workspace.revealLeaf(
        this.app.workspace.getLeavesOfType(VIDEO_VIEW)[0]
    );

    // This triggers the React component to be loaded
    for (const leaf of this.app.workspace.getLeavesOfType(VIDEO_VIEW)) {
      if (leaf.view instanceof VideoView) {

        const setupPlayer = (player: ReactPlayer, setPlaying: React.Dispatch<React.SetStateAction<boolean>>) => {
          this.player = player;
          this.setPlaying = setPlaying;
        }

        const setupError = (err: string) => {
          editor.replaceSelection(editor.getSelection() + `\n> [!error] Streaming Error \n> ${err}\n`);
        }

        const saveTimeOnUnload = async () => {
          if (this.player) {
            this.settings.urlStartTimeMap.set(url, Number(this.player.getCurrentTime().toFixed(0)));
          }
          await this.saveSettings();
        }

        // create a new video instance, sets up state/unload functionality, and passes in a start time if available else 0
        leaf.setEphemeralState({
          url,
          setupPlayer,
          setupError,
          saveTimeOnUnload,
          start: ~~this.settings.urlStartTimeMap.get(url)
        });

        await this.saveSettings();
      }
    }
  }

  async loadSettings() {
    // Fix for a weird bug that turns default map into a normal object when loaded
    const data = await this.loadData()
    if (data) {
      const map = new Map(Object.keys(data.urlStartTimeMap).map(k => [k, data.urlStartTimeMap[k]]))
      this.settings = { ...DEFAULT_SETTINGS, ...data, urlStartTimeMap: map };
    } else {
      this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  getObsidianClientID() {
    let obsidianClientId = window.localStorage.getItem('rw-ObsidianClientId');
    if (obsidianClientId) {
      return obsidianClientId;
    } else {
      obsidianClientId = Math.random().toString(36).substring(2, 15);
      window.localStorage.setItem('rw-ObsidianClientId', obsidianClientId);
      return obsidianClientId;
    }
  }

  async getUserAuthToken(button: HTMLElement, attempt = 0) {
    let uuid = this.getObsidianClientID();
    let sysinfo = await SystemInfo.systemInfoFn();
    if (attempt === 0) {
      window.open(`${baseURL}/auth_attempt?client=${uuid}&platform=obsidian`);
    }

    let response, data: ReclippedAuthResponse;
    try {
      response = await fetch(
        `${baseURL}/api/user/token?client=${uuid}&platform=obsidian&sysinfo=${encodeURI(JSON.stringify(sysinfo))}`
      );
    } catch (e) {
      console.log("ReClipped Official plugin: fetch failed in getUserAuthToken: ", e);
    }
    if (response && response.ok) {
      data = await response.json();
    } else {
      console.log("ReClipped Official plugin: bad response in getUserAuthToken: ", response);
      this.showInfoStatus(button.parentElement, "Authorization failed. Try again", "rw-error");
      return;
    }
    if (data.userAccessToken) {
      this.settings.token = data.userAccessToken;
    } else {
      if (attempt > 20) {
        console.log('ReClipped Official plugin: reached attempt limit in getUserAuthToken');
        return;
      }
      console.log(`ReClipped Official plugin: didn't get token data, retrying (attempt ${attempt + 1})`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      await this.getUserAuthToken(button, attempt + 1);
    }
    await this.saveSettings();
    return true;
  }
}

class ReclippedSettingTab extends PluginSettingTab {
  plugin: ReclippedPlugin;

  constructor(app: App, plugin: ReclippedPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }


  display(): void {
    let {containerEl} = this;

    containerEl.empty();
    containerEl.createEl('h1', {text: 'ReClipped Official'});
    containerEl.createEl('p', {text: 'Created by '}).createEl('a', {text: 'ReClipped', href: 'https://reclipped.com'});
    containerEl.getElementsByTagName('p')[0].appendText(' 📝');
    containerEl.createEl('h2', {text: 'Settings'});

    if (this.plugin.settings.token) {
      new Setting(containerEl)
        .setName("Sync your ReClipped data with Obsidian")
        .setDesc("On first sync, the ReClipped plugin will create a new folder containing all your annotations")
        .setClass('rw-setting-sync')
        .addButton((button) => {
          button.setCta().setTooltip("Once the sync begins, you can close this plugin page")
            .setButtonText('Initiate Sync')
            .onClick(async () => {
              if (this.plugin.settings.isSyncing) {
                // NOTE: This is used to prevent multiple syncs at the same time. However, if a previous sync fails,
                //  it can stop new syncs from happening. Make sure to set isSyncing to false
                //  if there's ever errors/failures in previous sync attempts, so that
                //  we don't block syncing subsequent times.
                new Notice("sync with ReClipped already in progress");
              } else {
                this.plugin.clearInfoStatus(containerEl);
                this.plugin.settings.isSyncing = true;
                await this.plugin.saveData(this.plugin.settings);
                button.setButtonText("Syncing...");
                await this.plugin.requestArchive(button);
              }

            });
        });
      let el = containerEl.createEl("div", {cls: "rw-info-container"});
      containerEl.find(".rw-setting-sync > .setting-item-control ").prepend(el);

      // new Setting(containerEl)
      //   .setName("Customize formatting options")
      //   .setDesc("You can customize which items export to Obsidian and how they appear from the ReClipped website")
      //   .addButton((button) => {
      //     button.setButtonText("Customize").onClick(() => {
      //       window.open(`${baseURL}/export/obsidian/preferences`);
      //     });
      //   });

      new Setting(containerEl)
        .setName('Customize base folder')
        .setDesc("By default, the plugin will save all your annotations into a folder named ReClipped")
        // TODO: change this to search filed when the API is exposed (https://github.com/obsidianmd/obsidian-api/issues/22)
        .addText(text => text
          .setPlaceholder('Defaults to: ReClipped')
          .setValue(this.plugin.settings.reclippedDir)
          .onChange(async (value) => {
            this.plugin.settings.reclippedDir = normalizePath(value || "ReClipped");
            await this.plugin.saveSettings();
          }));

      new Setting(containerEl)
        .setName('Configure resync frequency')
        .setDesc("If not set to Manual, ReClipped will automatically resync with Obsidian when the app is open at the specified interval")
        .addDropdown(dropdown => {
          dropdown.addOption("0", "Manual");
          dropdown.addOption("60", "Every 1 hour");
          dropdown.addOption((12 * 60).toString(), "Every 12 hours");
          dropdown.addOption((24 * 60).toString(), "Every 24 hours");

          // select the currently-saved option
          dropdown.setValue(this.plugin.settings.frequency);

          dropdown.onChange((newValue) => {
            // update the plugin settings
            this.plugin.settings.frequency = newValue;
            this.plugin.saveSettings();

            // destroy & re-create the scheduled task
            this.plugin.configureSchedule();
          });
        });
      new Setting(containerEl)
        .setName("Sync automatically when Obsidian opens")
        .setDesc("If enabled, ReClipped will automatically resync with Obsidian each time you open the app")
        .addToggle((toggle) => {
            toggle.setValue(this.plugin.settings.triggerOnLoad);
            toggle.onChange((val) => {
              this.plugin.settings.triggerOnLoad = val;
              this.plugin.saveSettings();
            });
          }
        );
      new Setting(containerEl)
        .setName("Resync deleted files")
        .setDesc("If enabled, you can refresh individual items by deleting the file in Obsidian and initiating a resync")
        .addToggle((toggle) => {
            toggle.setValue(this.plugin.settings.refreshVideos);
            toggle.onChange(async (val) => {
              this.plugin.settings.refreshVideos = val;
              await this.plugin.saveSettings();
              if (val) {
                this.plugin.refreshDocumentExport();
              }
            });
          }
        );

      if (this.plugin.settings.lastSyncFailed) {
        this.plugin.showInfoStatus(containerEl.find(".rw-setting-sync .rw-info-container").parentElement, "Last sync failed", "rw-error");
      }
    }
    if (!this.plugin.settings.token) {
      new Setting(containerEl)
        .setName("Connect Obsidian to ReClipped")
        .setClass("rw-setting-connect")
        .setDesc("The ReClipped plugin enables automatic syncing of all your annotations from video platforms. Note: Requires ReClipped account.")
        .addButton((button) => {
          button.setButtonText("Connect").setCta().onClick(async (evt) => {
            const success = await this.plugin.getUserAuthToken(evt.target as HTMLElement);
            if (success) {
              this.display();
            }
          });
        });
      let el = containerEl.createEl("div", {cls: "rw-info-container"});
      containerEl.find(".rw-setting-connect > .setting-item-control ").prepend(el);
    }
    const help = containerEl.createEl('p',);
    help.innerHTML = "Question? Please see our <a href='https://blog.reclipped.com/reclipped-for-podcasts-be3d6678ea47'>Documentation</a> or email us at <a href='mailto:admin@reclipped.com'>admin@reclipped.com</a> 🙂";
  }
}

