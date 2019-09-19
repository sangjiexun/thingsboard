///
/// Copyright © 2016-2019 The Thingsboard Authors
///
/// Licensed under the Apache License, Version 2.0 (the "License");
/// you may not use this file except in compliance with the License.
/// You may obtain a copy of the License at
///
///     http://www.apache.org/licenses/LICENSE-2.0
///
/// Unless required by applicable law or agreed to in writing, software
/// distributed under the License is distributed on an "AS IS" BASIS,
/// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
/// See the License for the specific language governing permissions and
/// limitations under the License.
///

import { PageComponent } from '@shared/components/page.component';
import { Component, ElementRef, Inject, OnDestroy, OnInit, ViewChild, ViewEncapsulation } from '@angular/core';
import { WidgetsBundle } from '@shared/models/widgets-bundle.model';
import { Store } from '@ngrx/store';
import { AppState } from '@core/core.state';
import { WidgetService } from '@core/http/widget.service';
import { WidgetInfo } from '@home/models/widget-component.models';
import { WidgetConfig, widgetType, WidgetType, widgetTypesData, Widget } from '@shared/models/widget.models';
import { ActivatedRoute } from '@angular/router';
import { deepClone } from '@core/utils';
import { HasDirtyFlag } from '@core/guards/confirm-on-exit.guard';
import { AuthUser } from '@shared/models/user.model';
import { getCurrentAuthUser } from '@core/auth/auth.selectors';
import { Authority } from '@shared/models/authority.enum';
import { NULL_UUID } from '@shared/models/id/has-uuid';
import { Hotkey, HotkeysService } from 'angular2-hotkeys';
import { TranslateService } from '@ngx-translate/core';
import { getCurrentIsLoading } from '@app/core/interceptors/load.selectors';
import * as ace from 'ace-builds';
import { css_beautify, html_beautify } from 'js-beautify';
import { CancelAnimationFrame, RafService } from '@core/services/raf.service';
import { WINDOW } from '@core/services/window.service';
import { WindowMessage } from '@shared/models/window-message.model';
import { ExceptionData } from '@shared/models/error.models';
import Timeout = NodeJS.Timeout;
import { ActionNotificationHide, ActionNotificationShow } from '@core/notification/notification.actions';

@Component({
  selector: 'tb-widget-editor',
  templateUrl: './widget-editor.component.html',
  styleUrls: ['./widget-editor.component.scss'],
  encapsulation: ViewEncapsulation.None
})
export class WidgetEditorComponent extends PageComponent implements OnInit, OnDestroy, HasDirtyFlag {

  @ViewChild('topPanel', {static: true})
  topPanelElmRef: ElementRef;

  @ViewChild('topLeftPanel', {static: true})
  topLeftPanelElmRef: ElementRef;

  @ViewChild('topRightPanel', {static: true})
  topRightPanelElmRef: ElementRef;

  @ViewChild('bottomPanel', {static: true})
  bottomPanelElmRef: ElementRef;

  @ViewChild('javascriptPanel', {static: true})
  javascriptPanelElmRef: ElementRef;

  @ViewChild('framePanel', {static: true})
  framePanelElmRef: ElementRef;

  @ViewChild('htmlInput', {static: true})
  htmlInputElmRef: ElementRef;

  @ViewChild('cssInput', {static: true})
  cssInputElmRef: ElementRef;

  @ViewChild('settingsJsonInput', {static: true})
  settingsJsonInputElmRef: ElementRef;

  @ViewChild('dataKeySettingsJsonInput', {static: true})
  dataKeySettingsJsonInputElmRef: ElementRef;

  @ViewChild('javascriptInput', {static: true})
  javascriptInputElmRef: ElementRef;

  @ViewChild('widgetIFrame', {static: true})
  widgetIFrameElmRef: ElementRef<HTMLIFrameElement>;

  iframe: JQuery<HTMLIFrameElement>;

  widgetTypes = widgetType;
  allWidgetTypes = Object.keys(widgetType);
  widgetTypesDataMap = widgetTypesData;

  authUser: AuthUser;

  isReadOnly: boolean;

  widgetsBundle: WidgetsBundle;
  widgetType: WidgetType;
  widget: WidgetInfo;
  origWidget: WidgetInfo;

  isDirty = false;

  fullscreen = false;
  htmlFullscreen = false;
  cssFullscreen = false;
  jsonSettingsFullscreen = false;
  jsonDataKeySettingsFullscreen = false;
  javascriptFullscreen = false;
  iFrameFullscreen = false;

  aceEditors: ace.Ace.Editor[] = [];
  editorsResizeCafs: {[editorId: string]: CancelAnimationFrame} = {};
  htmlEditor: ace.Ace.Editor;
  cssEditor: ace.Ace.Editor;
  jsonSettingsEditor: ace.Ace.Editor;
  dataKeyJsonSettingsEditor: ace.Ace.Editor;
  jsEditor: ace.Ace.Editor;
  aceResizeListeners: { element: any, resizeListener: any }[] = [];

  onWindowMessageListener = this.onWindowMessage.bind(this);

  iframeWidgetEditModeInited = false;
  saveWidgetPending = false;
  saveWidgetAsPending = false;

  gotError = false;
  errorMarkers: number[] = [];
  errorAnnotationId = -1;

  saveWidgetTimeout: Timeout;

  constructor(protected store: Store<AppState>,
              @Inject(WINDOW) private window: Window,
              private route: ActivatedRoute,
              private widgetService: WidgetService,
              private hotkeysService: HotkeysService,
              private translate: TranslateService,
              private raf: RafService) {
    super(store);

    this.authUser = getCurrentAuthUser(store);

    this.widgetsBundle = this.route.snapshot.data.widgetsBundle;
    if (this.authUser.authority === Authority.TENANT_ADMIN) {
      this.isReadOnly = !this.widgetsBundle || this.widgetsBundle.tenantId.id === NULL_UUID;
    } else {
      this.isReadOnly = this.authUser.authority !== Authority.SYS_ADMIN;
    }
    this.widgetType = this.route.snapshot.data.widgetEditorData.widgetType;
    this.widget = this.route.snapshot.data.widgetEditorData.widget;
    if (this.widgetType) {
      const config = JSON.parse(this.widget.defaultConfig);
      this.widget.defaultConfig = JSON.stringify(config);
    }
    this.origWidget = deepClone(this.widget);
    if (!this.widgetType) {
      this.isDirty = true;
    }
  }

  ngOnInit(): void {
    this.initHotKeys();
    this.initSplitLayout();
    this.initAceEditors();
    this.iframe = $(this.widgetIFrameElmRef.nativeElement);
    this.window.addEventListener('message', this.onWindowMessageListener);
    this.iframe.attr('data-widget', JSON.stringify(this.widget));
    this.iframe.attr('src', '/widget-editor');
  }

  ngOnDestroy(): void {
    this.window.removeEventListener('message', this.onWindowMessageListener);
    this.aceResizeListeners.forEach((resizeListener) => {
      // @ts-ignore
      removeResizeListener(resizeListener.element, resizeListener.resizeListener);
    });
  }

  private initHotKeys(): void {
    this.hotkeysService.add(
      new Hotkey('ctrl+q', (event: KeyboardEvent) => {
        if (!getCurrentIsLoading(this.store) && !this.undoDisabled()) {
          event.preventDefault();
          this.undoWidget();
        }
        return false;
      }, ['INPUT', 'SELECT', 'TEXTAREA'],
        this.translate.instant('widget.undo'))
    );
    this.hotkeysService.add(
      new Hotkey('ctrl+s', (event: KeyboardEvent) => {
          if (!getCurrentIsLoading(this.store) && !this.saveDisabled()) {
            event.preventDefault();
            this.saveWidget();
          }
          return false;
        }, ['INPUT', 'SELECT', 'TEXTAREA'],
        this.translate.instant('widget.save'))
    );
    this.hotkeysService.add(
      new Hotkey('shift+ctrl+s', (event: KeyboardEvent) => {
          if (!getCurrentIsLoading(this.store) && !this.saveAsDisabled()) {
            event.preventDefault();
            this.saveWidgetAs();
          }
          return false;
        }, ['INPUT', 'SELECT', 'TEXTAREA'],
        this.translate.instant('widget.saveAs'))
    );
    this.hotkeysService.add(
      new Hotkey('shift+ctrl+f', (event: KeyboardEvent) => {
          event.preventDefault();
          this.fullscreen = !this.fullscreen;
          return false;
        }, ['INPUT', 'SELECT', 'TEXTAREA'],
        this.translate.instant('widget.toggle-fullscreen'))
    );
    this.hotkeysService.add(
      new Hotkey('ctrl+enter', (event: KeyboardEvent) => {
          event.preventDefault();
          this.applyWidgetScript();
          return false;
        }, ['INPUT', 'SELECT', 'TEXTAREA'],
        this.translate.instant('widget.run'))
    );
  }

  private initSplitLayout() {
    Split([this.topPanelElmRef.nativeElement, this.bottomPanelElmRef.nativeElement], {
      sizes: [35, 65],
      gutterSize: 8,
      cursor: 'row-resize',
      direction: 'vertical'
    });
    Split([this.topLeftPanelElmRef.nativeElement, this.topRightPanelElmRef.nativeElement], {
      sizes: [50, 50],
      gutterSize: 8,
      cursor: 'col-resize'
    });
    Split([this.javascriptPanelElmRef.nativeElement, this.framePanelElmRef.nativeElement], {
      sizes: [50, 50],
      gutterSize: 8,
      cursor: 'col-resize'
    });
  }

  private initAceEditors() {
    this.htmlEditor = this.createAceEditor(this.htmlInputElmRef, 'html');
    this.htmlEditor.on('input', () => {
      const editorValue = this.htmlEditor.getValue();
      if (this.widget.templateHtml !== editorValue) {
        this.widget.templateHtml = editorValue;
        this.isDirty = true;
      }
    });
    this.cssEditor = this.createAceEditor(this.cssInputElmRef, 'css');
    this.cssEditor.on('input', () => {
      const editorValue = this.cssEditor.getValue();
      if (this.widget.templateCss !== editorValue) {
        this.widget.templateCss = editorValue;
        this.isDirty = true;
      }
    });
    this.jsonSettingsEditor = this.createAceEditor(this.settingsJsonInputElmRef, 'json');
    this.jsonSettingsEditor.on('input', () => {
      const editorValue = this.jsonSettingsEditor.getValue();
      if (this.widget.settingsSchema !== editorValue) {
        this.widget.settingsSchema = editorValue;
        this.isDirty = true;
      }
    });
    this.dataKeyJsonSettingsEditor = this.createAceEditor(this.dataKeySettingsJsonInputElmRef, 'json');
    this.dataKeyJsonSettingsEditor.on('input', () => {
      const editorValue = this.dataKeyJsonSettingsEditor.getValue();
      if (this.widget.dataKeySettingsSchema !== editorValue) {
        this.widget.dataKeySettingsSchema = editorValue;
        this.isDirty = true;
      }
    });
    this.jsEditor = this.createAceEditor(this.javascriptInputElmRef, 'javascript');
    this.jsEditor.on('input', () => {
      const editorValue = this.jsEditor.getValue();
      if (this.widget.controllerScript !== editorValue) {
        this.widget.controllerScript = editorValue;
        this.isDirty = true;
      }
    });
    this.jsEditor.on('change', () => {
      this.cleanupJsErrors();
    });
    this.setAceEditorValues();
  }

  private setAceEditorValues() {
    this.htmlEditor.setValue(this.widget.templateHtml ? this.widget.templateHtml : '', -1);
    this.cssEditor.setValue(this.widget.templateCss ? this.widget.templateCss : '', -1);
    this.jsonSettingsEditor.setValue(this.widget.settingsSchema ? this.widget.settingsSchema : '', -1);
    this.dataKeyJsonSettingsEditor.setValue(this.widget.dataKeySettingsSchema ? this.widget.dataKeySettingsSchema : '', -1);
    this.jsEditor.setValue(this.widget.controllerScript ? this.widget.controllerScript : '', -1);
  }

  private createAceEditor(editorElementRef: ElementRef, mode: string): ace.Ace.Editor {
    const editorElement = editorElementRef.nativeElement;
    let editorOptions: Partial<ace.Ace.EditorOptions> = {
      mode: `ace/mode/${mode}`,
      showGutter: true,
      showPrintMargin: true
    };
    const advancedOptions = {
      enableSnippets: true,
      enableBasicAutocompletion: true,
      enableLiveAutocompletion: true
    };
    editorOptions = {...editorOptions, ...advancedOptions};
    const aceEditor = ace.edit(editorElement, editorOptions);
    aceEditor.session.setUseWrapMode(true);
    this.aceEditors.push(aceEditor);

    const resizeListener = this.onAceEditorResize.bind(this, aceEditor);

    // @ts-ignore
    addResizeListener(editorElement, resizeListener);
    this.aceResizeListeners.push({element: editorElement, resizeListener});
    return aceEditor;
  }

  private onAceEditorResize(aceEditor: ace.Ace.Editor) {
    if (this.editorsResizeCafs[aceEditor.id]) {
      this.editorsResizeCafs[aceEditor.id]();
      delete this.editorsResizeCafs[aceEditor.id];
    }
    this.editorsResizeCafs[aceEditor.id] = this.raf.raf(() => {
      aceEditor.resize();
      aceEditor.renderer.updateFull();
    });
  }

  private onWindowMessage(event: MessageEvent) {
    let message: WindowMessage;
    if (event.data) {
      try {
        message = JSON.parse(event.data);
      } catch (e) {}
    }
    if (message) {
      switch (message.type) {
        case 'widgetException':
          this.onWidgetException(message.data);
          break;
        case 'widgetEditModeInited':
          this.onWidgetEditModeInited();
          break;
        case 'widgetEditUpdated':
          this.onWidgetEditUpdated(message.data);
          break;
      }
    }
  }

  private onWidgetEditModeInited() {
    this.iframeWidgetEditModeInited = true;
    if (this.saveWidgetPending || this.saveWidgetAsPending) {
      if (!this.saveWidgetTimeout) {
        this.saveWidgetTimeout = setTimeout(() => {
          if (!this.gotError) {
            if (this.saveWidgetPending) {
              this.commitSaveWidget();
            } else if (this.saveWidgetAsPending) {
              this.commitSaveWidgetAs();
            }
          } else {
            this.store.dispatch(new ActionNotificationShow(
              {message: this.translate.instant('widget.unable-to-save-widget-error'), type: 'error'}));
            this.saveWidgetPending = false;
            this.saveWidgetAsPending = false;
          }
          this.saveWidgetTimeout = undefined;
        }, 1500);
      }
    }
  }

  private onWidgetEditUpdated(widget: Widget) {
    this.widget.sizeX = widget.sizeX / 2;
    this.widget.sizeY = widget.sizeY / 2;
    this.widget.defaultConfig = JSON.stringify(widget.config);
    this.iframe.attr('data-widget', JSON.stringify(this.widget));
    this.isDirty = true;
  }

  private onWidgetException(details: ExceptionData) {
    if (!this.gotError) {
      this.gotError = true;
      let errorInfo = 'Error:';
      if (details.name) {
        errorInfo += ' ' + details.name + ':';
      }
      if (details.message) {
        errorInfo += ' ' + details.message;
      }
      if (details.lineNumber) {
        errorInfo += '<br>Line ' + details.lineNumber;
        if (details.columnNumber) {
          errorInfo += ' column ' + details.columnNumber;
        }
        errorInfo += ' of script.';
      }
      if (!this.saveWidgetPending && !this.saveWidgetAsPending) {
        this.store.dispatch(new ActionNotificationShow(
          {message: errorInfo, type: 'error', target: 'javascriptPanel'}));
      }
      if (details.lineNumber) {
        const line = details.lineNumber - 1;
        let column = 0;
        if (details.columnNumber) {
          column = details.columnNumber;
        }
        const errorMarkerId = this.jsEditor.session.addMarker(new ace.Range(line, 0, line, Infinity),
          'ace_active-line', 'screenLine');
        this.errorMarkers.push(errorMarkerId);
        const annotations = this.jsEditor.session.getAnnotations();
        const errorAnnotation: ace.Ace.Annotation = {
          row: line,
          column,
          text: details.message,
          type: 'error'
        };
        this.errorAnnotationId = annotations.push(errorAnnotation) - 1;
        this.jsEditor.session.setAnnotations(annotations);
      }
    }
  }

  private cleanupJsErrors() {
    this.store.dispatch(new ActionNotificationHide({}));
    this.errorMarkers.forEach((errorMarker) => {
      this.jsEditor.session.removeMarker(errorMarker);
    });
    this.errorMarkers.length = 0;
    if (this.errorAnnotationId > -1) {
      const annotations = this.jsEditor.session.getAnnotations();
      annotations.splice(this.errorAnnotationId, 1);
      this.jsEditor.session.setAnnotations(annotations);
      this.errorAnnotationId = -1;
    }
  }

  private commitSaveWidget() {
    // TODO:
    this.saveWidgetPending = false;
  }

  private commitSaveWidgetAs() {
    // TODO:
    this.saveWidgetAsPending = false;
  }

  applyWidgetScript(): void {
    this.cleanupJsErrors();
    this.gotError = false;
    this.iframeWidgetEditModeInited = false;
    const config: WidgetConfig = JSON.parse(this.widget.defaultConfig);
    config.title = this.widget.widgetName;
    this.widget.defaultConfig = JSON.stringify(config);
    this.iframe.attr('data-widget', JSON.stringify(this.widget));
    this.iframe[0].contentWindow.location.reload(true);
  }

  undoWidget(): void {
    this.widget = deepClone(this.origWidget);
    this.setAceEditorValues();
    this.isDirty = false;
    this.applyWidgetScript();
  }

  saveWidget(): void {
    if (!this.widget.widgetName) {
      this.store.dispatch(new ActionNotificationShow(
        {message: this.translate.instant('widget.missing-widget-title-error'), type: 'error'}));
    } else {
      this.saveWidgetPending = true;
      this.applyWidgetScript();
    }
  }

  saveWidgetAs(): void {
    this.saveWidgetAsPending = true;
    this.applyWidgetScript();
  }

  undoDisabled(): boolean {
    return !this.isDirty
    || !this.iframeWidgetEditModeInited
    || this.saveWidgetPending
    || this.saveWidgetAsPending;
  }

  saveDisabled(): boolean {
    return this.isReadOnly
      || !this.isDirty
      || !this.iframeWidgetEditModeInited
      || this.saveWidgetPending
      || this.saveWidgetAsPending;
  }

  saveAsDisabled(): boolean {
    return !this.iframeWidgetEditModeInited
      || this.saveWidgetPending
      || this.saveWidgetAsPending;
  }

  beautifyCss(): void {
    const res = css_beautify(this.widget.templateCss, {indent_size: 4});
    if (this.widget.templateCss !== res) {
      this.isDirty = true;
      this.widget.templateCss = res;
      this.cssEditor.setValue(this.widget.templateCss ? this.widget.templateCss : '', -1);
    }
  }

  beautifyHtml(): void {
    const res = html_beautify(this.widget.templateHtml, {indent_size: 4, wrap_line_length: 60});
    if (this.widget.templateHtml !== res) {
      this.isDirty = true;
      this.widget.templateHtml = res;
      this.htmlEditor.setValue(this.widget.templateHtml ? this.widget.templateHtml : '', -1);
    }
  }

  beautifyJson(): void {
    const res = js_beautify(this.widget.settingsSchema, {indent_size: 4});
    if (this.widget.settingsSchema !== res) {
      this.isDirty = true;
      this.widget.settingsSchema = res;
      this.jsonSettingsEditor.setValue(this.widget.settingsSchema ? this.widget.settingsSchema : '', -1);
    }
  }

  beautifyDataKeyJson(): void {
    const res = js_beautify(this.widget.dataKeySettingsSchema, {indent_size: 4});
    if (this.widget.dataKeySettingsSchema !== res) {
      this.isDirty = true;
      this.widget.dataKeySettingsSchema = res;
      this.dataKeyJsonSettingsEditor.setValue(this.widget.dataKeySettingsSchema ? this.widget.dataKeySettingsSchema : '', -1);
    }
  }

  beautifyJs(): void {
    const res = js_beautify(this.widget.controllerScript, {indent_size: 4, wrap_line_length: 60});
    if (this.widget.controllerScript !== res) {
      this.isDirty = true;
      this.widget.controllerScript = res;
      this.jsEditor.setValue(this.widget.controllerScript ? this.widget.controllerScript : '', -1);
    }
  }

  removeResource(index: number) {
    if (index > -1) {
      if (this.widget.resources.splice(index, 1).length > 0) {
        this.isDirty = true;
      }
    }
  }

  addResource() {
    this.widget.resources.push({url: ''});
    this.isDirty = true;
  }

  widetTypeChanged() {
    const config: WidgetConfig = JSON.parse(this.widget.defaultConfig);
    if (this.widget.type !== widgetType.rpc &&
        this.widget.type !== widgetType.alarm) {
      if (config.targetDeviceAliases) {
        delete config.targetDeviceAliases;
      }
      if (config.alarmSource) {
        delete config.alarmSource;
      }
      if (!config.datasources) {
        config.datasources = [];
      }
      if (!config.timewindow) {
        config.timewindow = {
          realtime: {
            timewindowMs: 60000
          }
        };
      }
    } else if (this.widget.type === widgetType.rpc) {
      if (config.datasources) {
        delete config.datasources;
      }
      if (config.alarmSource) {
        delete config.alarmSource;
      }
      if (config.timewindow) {
        delete config.timewindow;
      }
      if (!config.targetDeviceAliases) {
        config.targetDeviceAliases = [];
      }
    } else { // alarm
      if (config.datasources) {
        delete config.datasources;
      }
      if (config.targetDeviceAliases) {
        delete config.targetDeviceAliases;
      }
      if (!config.alarmSource) {
        config.alarmSource = {};
      }
      if (!config.timewindow) {
        config.timewindow = {
          realtime: {
            timewindowMs: 24 * 60 * 60 * 1000
          }
        };
      }
    }
    this.widget.defaultConfig = JSON.stringify(config);
    this.isDirty = true;
  }
}
