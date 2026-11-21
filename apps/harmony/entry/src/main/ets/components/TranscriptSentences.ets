import { TranscriptSegment } from '../services/AccountSync';

interface SentenceBounds { top: number; bottom: number; }

@Component
export struct TranscriptSentences {
  @Prop segments: TranscriptSegment[] = [];
  @Prop selectedIds: string[] = [];
  @Prop activeId: string = '';
  @Prop searchId: string = '';
  @Prop chapterId: string = '';
  @Prop contextRevision: number = 0;
  @Prop canPlay: boolean = false;
  onPlay: (id: string) => void = () => {};
  onSelect: (anchor: string, end: string) => void = () => {};
  onToggle: (id: string) => void = () => {};
  onRowArea: (id: string, area: Area) => void = () => {};
  onDrag: (active: boolean) => void = () => {};
  onEdgeScroll: (dy: number) => void = () => {};
  viewportTop: () => number = () => 0;
  viewportHeight: () => number = () => 0;
  scrollOffset: () => number = () => 0;

  private bounds: Map<string, SentenceBounds> = new Map();
  private anchor: string = '';
  private end: string = '';
  private longPressed: boolean = false;
  private suppressClickUntil: number = 0;
  private fingerY: number = 0;
  private scrollTimer: number = 0;

  aboutToDisappear(): void {
    this.finishDrag();
    this.bounds.clear();
  }

  private time(ms: number): string {
    const seconds: number = Math.floor(ms / 1000);
    return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, '0')}`;
  }

  private recordRow(id: string, area: Area): void {
    const top: number = this.scrollOffset() + Number(area.globalPosition.y);
    this.bounds.set(id, { top, bottom: top + Number(area.height) });
    this.onRowArea(id, area);
  }

  private tap(id: string): void {
    if (this.longPressed || Date.now() < this.suppressClickUntil) return;
    if (this.selectedIds.length > 0) this.onToggle(id);
    else if (this.canPlay) this.onPlay(id);
  }

  private startDrag(id: string): void {
    this.longPressed = true;
    this.anchor = id;
    this.end = id;
    this.onDrag(true);
    this.onSelect(id, id);
  }

  private finishDrag(): void {
    if (this.scrollTimer !== 0) clearInterval(this.scrollTimer);
    this.scrollTimer = 0;
    if (this.longPressed) {
      this.longPressed = false;
      this.suppressClickUntil = Date.now() + 350;
    }
    if (!this.anchor) return;
    this.anchor = '';
    this.end = '';
    this.onDrag(false);
  }

  private extendAtFinger(): void {
    const top: number = this.viewportTop();
    const y: number = Math.max(top, Math.min(top + this.viewportHeight(), this.fingerY)) + this.scrollOffset();
    for (const sentence of this.segments) {
      const row: SentenceBounds | undefined = this.bounds.get(sentence.id);
      if (row && y >= row.top && y <= row.bottom) {
        if (sentence.id !== this.end) {
          this.end = sentence.id;
          this.onSelect(this.anchor, this.end);
        }
        break;
      }
    }
  }

  private edgeStep(): number {
    if (!this.anchor || !this.segments.length) return 0;
    const height: number = this.viewportHeight();
    const edge: number = Math.min(48, height / 5);
    const localY: number = this.fingerY - this.viewportTop();
    const offset: number = this.scrollOffset() + this.viewportTop();
    if (localY < edge) {
      const first = this.bounds.get(this.segments[0].id);
      return first ? -Math.min(16, Math.max(0, offset - first.top)) : 0;
    }
    if (localY > height - edge) {
      const last = this.bounds.get(this.segments[this.segments.length - 1].id);
      return last ? Math.min(16, Math.max(0, last.bottom - offset - height)) : 0;
    }
    return 0;
  }

  private moveDrag(event: GestureEvent): void {
    if (!this.anchor || !event.fingerList[0]) return;
    this.fingerY = event.fingerList[0].globalY;
    this.extendAtFinger();
    if (this.scrollTimer === 0 && this.edgeStep() !== 0) {
      this.scrollTimer = setInterval(() => {
        this.extendAtFinger();
        const step: number = this.edgeStep();
        if (step === 0) { clearInterval(this.scrollTimer); this.scrollTimer = 0; return; }
        this.onEdgeScroll(step);
      }, 60);
    }
  }

  build() {
    Column() {
      ForEach(this.segments, (sentence: TranscriptSegment) => {
        Row({ space: 8 }) {
          Text(this.time(sentence.startMs)).width(44).fontSize(12)
            .fontColor(this.activeId === sentence.id ? $r('app.color.yuqu_accent_ink') : $r('app.color.yuqu_muted'))
          Column({ space: 2 }) {
            if (this.searchId === sentence.id || this.chapterId === sentence.id) {
              Text(this.searchId === sentence.id ? '搜索命中' : '章节起点').fontSize(12).fontColor($r('app.color.yuqu_muted'))
            }
            Text(sentence.text).fontSize(16).lineHeight(25)
              .fontWeight(this.activeId === sentence.id ? FontWeight.Medium : FontWeight.Regular)
              .fontColor(this.activeId === sentence.id ? $r('app.color.yuqu_accent_ink') : $r('app.color.yuqu_ink'))
          }.layoutWeight(1).alignItems(HorizontalAlign.Start)
          Text(this.selectedIds.includes(sentence.id) ? '✓' : '').width(16).fontSize(16)
            .fontColor($r('app.color.yuqu_accent_ink'))
        }.id('transcript-sentence-' + sentence.id).width('100%').alignItems(VerticalAlign.Top)
          .padding({ left: 8, right: 4, top: 10, bottom: 10 }).constraintSize({ minHeight: 44 }).borderRadius(8)
          .border({ width: { left: 3 }, color: this.activeId === sentence.id ? $r('app.color.yuqu_accent_ink') : Color.Transparent })
          .backgroundColor(this.selectedIds.includes(sentence.id) ? $r('app.color.yuqu_accent_soft') :
            this.activeId === sentence.id || this.searchId === sentence.id || this.chapterId === sentence.id ?
            $r('app.color.yuqu_subtle') : $r('app.color.yuqu_surface'))
          .accessibilityGroup(true).accessibilitySelected(this.selectedIds.includes(sentence.id))
          .accessibilityText(`${this.time(sentence.startMs)}，${this.activeId === sentence.id ? '当前播放，' : ''}${sentence.text}`)
          .accessibilityDescription(this.selectedIds.length > 0 ? '点按调整所选范围' : this.canPlay ? '点按从此播放，长按选择' : '长按选择')
          .accessibilityCustomActions([{ name: '选择这句', onAction: () => { this.onSelect(sentence.id, sentence.id); } }])
          .onAreaChange((_old: Area, area: Area) => { this.recordRow(sentence.id, area); })
          .onDisAppear(() => { this.bounds.delete(sentence.id); })
          .onClick(() => { this.tap(sentence.id); })
          .onTouch((event: TouchEvent) => {
            if (event.type === TouchType.Down) this.suppressClickUntil = 0;
            if (event.type === TouchType.Up || event.type === TouchType.Cancel) this.finishDrag();
          })
          .gesture(GestureGroup(GestureMode.Sequence,
            LongPressGesture({ fingers: 1, duration: 430, repeat: false }).onAction(() => { this.startDrag(sentence.id); }),
            PanGesture({ fingers: 1, direction: PanDirection.All, distance: 2 })
              .onActionStart((event: GestureEvent) => { this.moveDrag(event); })
              .onActionUpdate((event: GestureEvent) => { this.moveDrag(event); })
              .onActionEnd(() => { this.finishDrag(); })
          ).onCancel(() => { this.finishDrag(); }))
      }, (sentence: TranscriptSegment) => `${sentence.id}:${sentence.endMs}:${sentence.text}:${this.searchId === sentence.id || this.chapterId === sentence.id ? this.contextRevision : 0}`)
    }.width('100%')
  }
}
