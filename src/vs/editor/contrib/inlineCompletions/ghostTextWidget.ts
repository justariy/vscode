/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./ghostText';
import * as dom from 'vs/base/browser/dom';
import { Disposable, DisposableStore, IDisposable, IReference, MutableDisposable, toDisposable } from 'vs/base/common/lifecycle';
import { Range } from 'vs/editor/common/core/range';
import { ContentWidgetPositionPreference, IActiveCodeEditor, ICodeEditor, IContentWidget, IContentWidgetPosition } from 'vs/editor/browser/editorBrowser';
import { ICodeEditorService } from 'vs/editor/browser/services/codeEditorService';
import * as strings from 'vs/base/common/strings';
import { RenderLineInput, renderViewLine } from 'vs/editor/common/viewLayout/viewLineRenderer';
import { EditorFontLigatures, EditorOption } from 'vs/editor/common/config/editorOptions';
import { createStringBuilder } from 'vs/editor/common/core/stringBuilder';
import { Configuration } from 'vs/editor/browser/config/configuration';
import { LineTokens } from 'vs/editor/common/core/lineTokens';
import { Position } from 'vs/editor/common/core/position';
import { Emitter, Event } from 'vs/base/common/event';
import { IModelDeltaDecoration } from 'vs/editor/common/model';
import { IThemeService, registerThemingParticipant } from 'vs/platform/theme/common/themeService';
import { editorSuggestPreviewBorder, editorSuggestPreviewOpacity } from 'vs/editor/common/view/editorColorRegistry';
import { RGBA, Color } from 'vs/base/common/color';

const ttPolicy = window.trustedTypes?.createPolicy('editorGhostText', { createHTML: value => value });

export interface GhostTextWidgetModel {
	readonly onDidChange: Event<void>;
	readonly ghostText: GhostText | undefined;

	setExpanded(expanded: boolean): void;
	readonly expanded: boolean;

	readonly minReservedLineCount: number;
}

export interface GhostText {
	readonly lines: string[];
	readonly position: Position;
}

export abstract class BaseGhostTextWidgetModel extends Disposable implements GhostTextWidgetModel {
	public abstract readonly ghostText: GhostText | undefined;

	private _expanded: boolean | undefined = undefined;

	protected readonly onDidChangeEmitter = new Emitter<void>();
	public readonly onDidChange = this.onDidChangeEmitter.event;

	public abstract readonly minReservedLineCount: number;

	public get expanded() {
		if (this._expanded === undefined) {
			return this.editor.getOption(EditorOption.suggest).suggestionPreviewExpanded;
		}
		return this._expanded;
	}

	constructor(protected readonly editor: IActiveCodeEditor) {
		super();

		this._register(editor.onDidChangeConfiguration((e) => {
			if (e.hasChanged(EditorOption.suggest) && this._expanded === undefined) {
				this.onDidChangeEmitter.fire();
			}
		}));
	}

	public setExpanded(expanded: boolean): void {
		this._expanded = true;
		this.onDidChangeEmitter.fire();
	}
}

export class GhostTextWidget extends Disposable {
	private static decorationTypeCount = 0;

	private codeEditorDecorationTypeKey: string | null = null;
	private readonly modelRef = this._register(new MutableDisposable<IReference<GhostTextWidgetModel>>());
	private decorationIds: string[] = [];
	private viewZoneId: string | null = null;
	private viewMoreContentWidget: ViewMoreLinesContentWidget | null = null;

	constructor(
		private readonly editor: ICodeEditor,
		@ICodeEditorService private readonly _codeEditorService: ICodeEditorService,
		@IThemeService private readonly _themeService: IThemeService,
	) {
		super();

		this._register(this.editor.onDidChangeConfiguration((e) => {
			if (
				e.hasChanged(EditorOption.disableMonospaceOptimizations)
				|| e.hasChanged(EditorOption.stopRenderingLineAfter)
				|| e.hasChanged(EditorOption.renderWhitespace)
				|| e.hasChanged(EditorOption.renderControlCharacters)
				|| e.hasChanged(EditorOption.fontLigatures)
				|| e.hasChanged(EditorOption.fontInfo)
				|| e.hasChanged(EditorOption.lineHeight)
			) {
				this.render();
			}
		}));
		this._register(toDisposable(() => {
			this.setModel(undefined);
		}));
	}

	public get model(): GhostTextWidgetModel | undefined {
		return this.modelRef.value?.object;
	}

	public setModel(model: GhostTextWidgetModel | undefined): void {
		if (model === this.model) { return; }
		this.modelRef.value = model
			? createDisposableRef(model, model.onDidChange(() => this.render()))
			: undefined;
		this.render();
	}

	private getRenderData() {
		if (!this.editor.hasModel() || !this.model?.ghostText) {
			return undefined;
		}

		const { minReservedLineCount, expanded } = this.model;
		let { position, lines } = this.model.ghostText;

		const textModel = this.editor.getModel();
		const maxColumn = textModel.getLineMaxColumn(position.lineNumber);
		const { tabSize } = textModel.getOptions();

		if (lines.length > 1 && position.column !== maxColumn) {
			console.warn('Can only show multiline ghost text at the end of a line');
			lines = [];
			position = new Position(position.lineNumber, maxColumn);
		}

		return { tabSize, position, lines, minReservedLineCount, expanded };
	}

	private render(): void {
		const renderData = this.getRenderData();

		if (this.codeEditorDecorationTypeKey) {
			this._codeEditorService.removeDecorationType(this.codeEditorDecorationTypeKey);
			this.codeEditorDecorationTypeKey = null;
		}

		if (renderData) {
			const suggestPreviewForeground = this._themeService.getColorTheme().getColor(editorSuggestPreviewOpacity);
			let opacity = '0.467';
			let color = 'white';
			if (suggestPreviewForeground) {
				function opaque(color: Color): Color {
					const { r, b, g } = color.rgba;
					return new Color(new RGBA(r, g, b, 255));
				}

				opacity = String(suggestPreviewForeground.rgba.a);
				color = Color.Format.CSS.format(opaque(suggestPreviewForeground))!;
			}
			// We add 0 to bring it before any other decoration.
			this.codeEditorDecorationTypeKey = `0-ghost-text-${++GhostTextWidget.decorationTypeCount}`;
			this._codeEditorService.registerDecorationType('ghost-text', this.codeEditorDecorationTypeKey, {
				after: {
					// TODO: escape?
					contentText: renderData.lines[0],
					opacity,
					color,
				},
			});
		}

		const newDecorations = new Array<IModelDeltaDecoration>();
		if (renderData && this.codeEditorDecorationTypeKey) {
			newDecorations.push({
				range: Range.fromPositions(renderData.position, renderData.position),
				options: {
					...this._codeEditorService.resolveDecorationOptions(this.codeEditorDecorationTypeKey, true),
				}
			});
		}
		this.decorationIds = this.editor.deltaDecorations(this.decorationIds, newDecorations);

		if (this.viewMoreContentWidget) {
			this.viewMoreContentWidget.dispose();
			this.viewMoreContentWidget = null;
		}

		this.editor.changeViewZones((changeAccessor) => {
			if (this.viewZoneId) {
				changeAccessor.removeZone(this.viewZoneId);
				this.viewZoneId = null;
			}

			if (renderData) {
				const remainingLines = renderData.lines.slice(1);
				const heightInLines = Math.max(remainingLines.length, renderData.minReservedLineCount);
				if (heightInLines > 0) {
					if (renderData.expanded) {
						const domNode = document.createElement('div');
						this.renderLines(domNode, renderData.tabSize, remainingLines);

						this.viewZoneId = changeAccessor.addZone({
							afterLineNumber: renderData.position.lineNumber,
							afterColumn: renderData.position.column,
							heightInLines: heightInLines,
							domNode,
						});
					} else if (remainingLines.length > 0) {
						this.viewMoreContentWidget = this.renderViewMoreLines(renderData.position, renderData.lines[0], remainingLines.length);
					}
				}
			}
		});
	}

	private renderViewMoreLines(position: Position, firstLineText: string, remainingLinesLength: number): ViewMoreLinesContentWidget {
		const fontInfo = this.editor.getOption(EditorOption.fontInfo);
		const domNode = document.createElement('div');
		domNode.className = 'suggest-preview-additional-widget';
		Configuration.applyFontInfoSlow(domNode, fontInfo);

		const spacer = document.createElement('span');
		spacer.className = 'content-spacer';
		spacer.append(firstLineText);
		domNode.append(spacer);

		const newline = document.createElement('span');
		newline.className = 'content-newline suggest-preview-text';
		newline.append('⏎  ');
		domNode.append(newline);

		const disposableStore = new DisposableStore();

		const button = document.createElement('div');
		button.className = 'button suggest-preview-text';
		button.append(`+${remainingLinesLength} lines…`);

		disposableStore.add(dom.addStandardDisposableListener(button, 'click', (e) => {
			this.model?.setExpanded(true);
			e.preventDefault();
			this.editor.focus();
		}));

		domNode.append(button);
		return new ViewMoreLinesContentWidget(this.editor, position, domNode, disposableStore);
	}

	private renderLines(domNode: HTMLElement, tabSize: number, lines: string[]): void {
		const opts = this.editor.getOptions();
		const disableMonospaceOptimizations = opts.get(EditorOption.disableMonospaceOptimizations);
		const stopRenderingLineAfter = opts.get(EditorOption.stopRenderingLineAfter);
		const renderWhitespace = opts.get(EditorOption.renderWhitespace);
		const renderControlCharacters = opts.get(EditorOption.renderControlCharacters);
		const fontLigatures = opts.get(EditorOption.fontLigatures);
		const fontInfo = opts.get(EditorOption.fontInfo);
		const lineHeight = opts.get(EditorOption.lineHeight);

		const sb = createStringBuilder(10000);
		sb.appendASCIIString('<div class="suggest-preview-text">');

		for (let i = 0, len = lines.length; i < len; i++) {
			const line = lines[i];
			sb.appendASCIIString('<div class="view-line');
			sb.appendASCIIString('" style="top:');
			sb.appendASCIIString(String(i * lineHeight));
			sb.appendASCIIString('px;width:1000000px;">');

			const isBasicASCII = strings.isBasicASCII(line);
			const containsRTL = strings.containsRTL(line);
			const lineTokens = LineTokens.createEmpty(line);

			renderViewLine(new RenderLineInput(
				(fontInfo.isMonospace && !disableMonospaceOptimizations),
				fontInfo.canUseHalfwidthRightwardsArrow,
				line,
				false,
				isBasicASCII,
				containsRTL,
				0,
				lineTokens,
				[],
				tabSize,
				0,
				fontInfo.spaceWidth,
				fontInfo.middotWidth,
				fontInfo.wsmiddotWidth,
				stopRenderingLineAfter,
				renderWhitespace,
				renderControlCharacters,
				fontLigatures !== EditorFontLigatures.OFF,
				null
			), sb);

			sb.appendASCIIString('</div>');
		}
		sb.appendASCIIString('</div>');

		Configuration.applyFontInfoSlow(domNode, fontInfo);
		const html = sb.build();
		const trustedhtml = ttPolicy ? ttPolicy.createHTML(html) : html;
		domNode.innerHTML = trustedhtml as string;
	}
}

class ViewMoreLinesContentWidget extends Disposable implements IContentWidget {
	readonly allowEditorOverflow = false;
	readonly suppressMouseDown = false;

	constructor(
		private editor: ICodeEditor,
		private position: Position,
		private domNode: HTMLElement,
		disposableStore: DisposableStore
	) {
		super();
		this._register(disposableStore);
		this._register(toDisposable(() => {
			this.editor.removeContentWidget(this);
		}));
		this.editor.addContentWidget(this);
	}

	getId(): string {
		return 'editor.widget.viewMoreLinesWidget';
	}

	getDomNode(): HTMLElement {
		return this.domNode;
	}

	getPosition(): IContentWidgetPosition | null {
		return {
			position: this.position,
			preference: [ContentWidgetPositionPreference.EXACT]
		};
	}
}

registerThemingParticipant((theme, collector) => {

	const suggestPreviewForeground = theme.getColor(editorSuggestPreviewOpacity);

	if (suggestPreviewForeground) {
		function opaque(color: Color): Color {
			const { r, b, g } = color.rgba;
			return new Color(new RGBA(r, g, b, 255));
		}

		const opacity = String(suggestPreviewForeground.rgba.a);
		const color = Color.Format.CSS.format(opaque(suggestPreviewForeground))!;

		// We need to override the only used token type .mtk1
		collector.addRule(`.monaco-editor .suggest-preview-text .mtk1 { opacity: ${opacity}; color: ${color}; }`);
	}

	const suggestPreviewBorder = theme.getColor(editorSuggestPreviewBorder);
	if (suggestPreviewBorder) {
		collector.addRule(`.monaco-editor .suggest-preview-text { border-bottom: 2px dashed ${suggestPreviewBorder}; }`);
	}
});

function createDisposableRef<T>(object: T, disposable: IDisposable): IReference<T> {
	return {
		object,
		dispose: () => disposable.dispose(),
	};
}
