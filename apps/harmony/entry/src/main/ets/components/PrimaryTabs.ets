@Component
export struct PrimaryTabs {
  @Prop section: string = 'listen';
  onSelect: (next: string) => void = () => {};

  @Builder
  tabItem(key: string, title: string, symbol: Resource) {
    Button({ type: ButtonType.Normal, stateEffect: true }) {
      Column({ space: 2 }) {
        SymbolGlyph(symbol)
          .fontSize(20)
          .fontColor([this.section === key ? $r('app.color.yuqu_accent_ink') : $r('app.color.yuqu_muted')])
        Text(title)
          .fontSize(12)
          .fontWeight(this.section === key ? FontWeight.Medium : FontWeight.Regular)
          .fontColor(this.section === key ? $r('app.color.yuqu_accent_ink') : $r('app.color.yuqu_muted'))
      }.width('100%')
    }
    .id('nav-' + key)
    .layoutWeight(1)
    .constraintSize({ minHeight: 48 })
    .padding({ top: 4, bottom: 4 })
    .borderRadius(12)
    .backgroundColor(this.section === key ? $r('app.color.yuqu_accent_soft') : $r('app.color.yuqu_surface'))
    .accessibilityText(title)
    .accessibilitySelected(this.section === key)
    .onClick(() => { if (this.section !== key) this.onSelect(key); })
  }

  build() {
    Row({ space: 6 }) {
      this.tabItem('library', '资料库', $r('sys.symbol.folder'))
      this.tabItem('listen', '收听', $r('sys.symbol.headphones'))
      this.tabItem('chat', '对话', $r('sys.symbol.message'))
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 4, bottom: 4 })
    .border({ width: { top: 0.5 }, color: $r('app.color.yuqu_line') })
    .backgroundColor($r('app.color.yuqu_surface'))
    .accessibilityRole(AccessibilityRoleType.TAB_BAR)
  }
}
