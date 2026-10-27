# dsh-model-capability-detector

瀵煎叆鎻愪緵鍟嗘椂鑷姩鎺㈡祴骞跺～鍐欐ā鍨嬭兘鍔涳紝鐪佸幓閫愰」鎵嬪～銆?
> English: [README.en.md](README.en.md)

## 杩欎釜鎻掍欢瑙ｅ喅浠€涔?
DSH 鐨勩€屾ā鍨嬨€嶈缃〉鏈韩浼氳姹傛彁渚涘晢鐨勬ā鍨嬪垪琛紝浣嗗畠鍙湪鐐瑰嚮銆岃幏鍙栨ā鍨嬨€嶆椂閲囩撼
`id`銆乣name`銆乣contextWindow`銆乣maxTokens` 鍜岃緭鍏ユā鎬佽繖鍑犻」锛屽瓧娈靛悕涓嶅畬鍏ㄤ竴鑷寸殑鍏冩暟鎹?浼氳涓㈠純锛屾€濊€冪瓑绾у垯瀹屽叏涓嶄細鑾峰彇銆?
鏈彃浠惰鍙栧悓涓€浠芥ā鍨嬪垪琛紝鎶婂叾涓?*鏄庣‘鎶湶**鐨勮兘鍔涘啓鍥炰綘鐨?profile锛?
| 瀛楁 | 鍚箟 |
|---|---|
| `contextWindow` | 妯″瀷鍙帴鍙楃殑涓婁笅鏂囬暱搴?|
| `maxTokens` | 妯″瀷澹版槑鐨勮緭鍑轰笂闄?|
| `input` | `["text"]` 鎴?`["text", "image"]` |
| `reasoningEfforts` | 妯″瀷鎻愪緵鐨勬€濊€冪瓑绾э紱涓嶆敮鎸佹€濊€冩椂涓?`false` |

## 瑙﹀彂鏃舵満

- 鍦ㄣ€屾ā鍨嬨€嶉〉淇濆瓨鎴栫紪杈戞彁渚涘晢閰嶇疆鍚庯紙`settings/document-updated`锛夈€?- profile 鐨勮ˉ涓侀噸鏂板崗璋冨畬鎴愬悗锛坄app-boot/config-reload`锛夈€?- 鍚姩鏁扮鍚庢墽琛屼竴娆″厹搴曟壂鎻忥紝瑕嗙洊銆屾彃浠跺綋鏃舵湭鍚敤銆嶆垨銆岀鐐瑰綋鏃朵笉鍙揪銆嶇殑閰嶇疆銆?
澶氭閰嶇疆鍐欏叆浼氳鍚堝苟鎴愪竴娆℃帰娴嬶紝涓斿悓涓€鏃跺埢鍙湁涓€涓帰娴嬪湪璺戙€?
## 鍒ゅ畾瑙勫垯

鍚勫妯″瀷鍒楄〃瀵瑰悓涓€鑳藉姏鐨勮〃杩版柟寮忓苟涓嶇粺涓€锛氬瓧娈靛悕涓嶅悓銆佸祵濂楀眰绾т笉鍚岋紝鐢氳嚦鍚屼竴椤硅兘鍔涘彲鑳芥槸甯冨皵鍊笺€?鏁扮粍鎴栧瓧绗︿覆銆傛帰娴嬭鐩栦互涓嬪父瑙佸啓娉曪細

- **涓婁笅鏂?* 鈥?`contextWindow`銆乣context_window`銆乣context_length`銆乣max_context_length`銆?  `max_model_len`銆乣max_input_tokens`銆乣limit.context`銆乣top_provider.context_length`銆?- **杈撳嚭涓婇檺** 鈥?`maxOutputTokens`銆乣max_output_tokens`銆乣max_tokens`銆?  `max_completion_tokens`銆乣limit.output`銆乣top_provider.max_completion_tokens`銆?- **璇嗗浘鑳藉姏** 鈥?`architecture.input_modalities`銆乣input_modalities`銆乣modalities.input`銆?  `input`銆乣architecture.modality`锛堝 `text+image->text`锛夛紝浠ュ強 `capabilities.vision`銆?  `supports_vision`銆乣vision` 绛夊竷灏旀爣蹇椼€?- **鎬濊€冪瓑绾?* 鈥?`reasoning.supported_efforts`銆乣reasoning.efforts`銆乣reasoning_efforts`銆?  `thinking_levels`銆乣supported_thinking_levels`銆乣parameters.reasoning_effort.enum`锛?  骞舵妸鍘傚晢鍐欐硶鏄犲皠鍒?pi-ai 鐨勮瘝姹囪〃锛坄none` 鈫?`off`銆乣mid` 鈫?`medium`銆?  `extra high` 鈫?`xhigh`銆乣ultra` 鈫?`max`锛夈€?
涓ょ鍒楄〃灏佽鏍煎紡閮戒細璇诲彇锛歄penAI 鐨?`{ "data": [...] }` 鏁扮粍锛屼互鍙婇儴鍒嗙綉鍏充娇鐢ㄧ殑
`{ "models": { "<id>": {鈥 } }` 鏄犲皠銆?
**绔偣娌℃湁鎶湶鐨勮兘鍔涗竴寰嬩笉鍐欍€?* 杩欓噷鐚滄祴鐨勪唬浠烽珮浜庣暀绌猴細`contextWindow` 鐚滃ぇ浼氬鑷村璇濊
闈欓粯鎴柇锛宍input` 鐚滈敊浼氳鏈鏀寔鐨勫浘鐗囨棤娉曞彂閫併€?
## 鍐欏叆鑼冨洿涓庣瓥鐣?
鍙鐞?*浣犺嚜宸?profile 灞傚０鏄?*鐨勮矾鐢便€傜敱宸插畨瑁?bundle 澹版槑鐨勮矾鐢变笉浼氳鏀瑰姩锛屽惁鍒欎細鎶婅璺敱鍐荤粨鎴?涓€浠藉壇鏈紝閬斀 bundle 鍚庣画鐨勬洿鏂般€?
榛樿绛栫暐鏄€屽凡鏈夊€间紭鍏堛€嶏紝鍙ˉ绌哄瓧娈碉紱璁剧疆 `overwrite: true` 鎵嶄細瑕嗙洊鍒楄〃鎶湶鐨勫€笺€?
鍐欏叆缁忕敱 settings 鏈嶅姟锛屽洜姝よ惤鍦?profile 鑷繁鐨?`cordis.patch.yml`锛岃蛋姝ｅ父 Loader 娴佺▼鐢熸晥锛屾棤闇€閲嶅惎銆?
## 鍏充簬 HMR 浜嬪姟鐨勯檺鍒?
`settings.update` 鏈€缁堜細璋冪敤 `configEditor.edit`锛屽悗鑰呮妸宸ヤ綔鍖呭湪 `hmr.runExclusive` 閲岋紝
閬囧埌宓屽浜嬪姟浼氭姏 `HMR transactions cannot be nested`銆傝€?Loader 婵€娲绘彃浠舵湰韬氨鍦ㄨ繖涓嫭鍗?浣滅敤鍩熷唴鎵ц锛宍app-boot/config-reload` 涔熶粠鍐呴儴鍙戝竷锛屾墍浠ョ敱姝ゅ惎鍔ㄧ殑鎺㈡祴浼氶€氳繃瀹氭椂鍣ㄥ拰 Promise
缁ф壙璇ヤ簨鍔℃爣璁般€?
鍥犳鍐欏湪 `AsyncLocalStorage.exit` 涓嬫墽琛屸€斺€旇繖鏄寮€璇ヤ綔鐢ㄥ煙鍞竴鏈夋枃妗ｄ繚璇佺殑鏂瑰紡銆傛崲鎴愭柊寤?`AsyncResource` 鏃犳晥锛氬畠鎹曡幏鐨勬槸鏋勯€犳椂鐨?store锛岃€?`apply` 鎵ц鏃跺凡缁忓湪浜嬪姟鍐呫€?
杩欎竴鐐圭粡杩囩鍒扮楠岃瘉锛岃€屼笉鍙槸鍗曞厓娴嬭瘯锛氬畨瑁呭悗鍚?profile 鍔犲叆涓€鏉℃寚鍚戝叕寮€鍒楄〃鐨勪复鏃惰矾鐢憋紝
璇ヨ矾鐢辩殑 `contextWindow`銆乣maxTokens`銆乣input`銆乣reasoningEfforts` 鍏ㄩ儴琚嚜鍔ㄥ～鍏ワ紝闅忓悗绉婚櫎璇ヨ矾鐢?骞惰繕鍘?profile銆?
## 閰嶇疆椤?
缂栬緫 profile 鐨?`cordis.patch.yml` 涓搴旇锛?
```yaml
- id: model-capability-detector
  name: "dsh-model-capability-detector"
  config:
    settingsNs: llm-pi-ai   # 瑕佸～鍏呯殑閫傞厤鍣?profile 鏉＄洰 id
    enabled: true           # false 瀹屽叏鍏抽棴鑷姩鎺㈡祴
    overwrite: false        # true 瑕嗙洊浣犲凡璁剧疆鐨勫€?    dryRun: false           # true 鍙褰曡鍒掞紝涓嶅啓 profile
    timeoutMs: 15000        # 鍗曠鐐规帰娴嬭秴鏃?    debounceMs: 800         # 閰嶇疆鍙樻洿鍚庣殑闈欓粯鏈?    startupDelayMs: 3000    # 鍚姩鍏滃簳鎵弿鐨勫欢杩?    maxResponseBytes: 4194304
```

鎺ュ叆鏂扮綉鍏虫椂寤鸿鍏堣 `dryRun: true`锛氬彧浼氬湪鏃ュ織閲屽垪鍑哄皢瑕佸啓鍏ョ殑鍐呭锛屼笉鏀瑰姩 profile銆?
## 鍑嵁浣跨敤

鎺㈡祴璇锋眰浣跨敤璺敱鑷韩鐨?`apiKeyEnv` 寮曠敤锛岀粡 credentials 鏈嶅姟鍦ㄨ皟鐢ㄦ椂瑙ｆ瀽鈥斺€斾笌閫傞厤鍣ㄧ敤鐨勬槸鍚屼竴涓?寮曠敤锛屽洜姝ゅ湪銆屾ā鍨嬨€嶉〉杞崲瀵嗛挜鍚庢棤闇€閲嶅惎鍗冲彲鐢熸晥銆傛湭閰嶇疆 `apiKeyEnv` 鐨勮矾鐢变互鏃犻壌鏉冩柟寮忔帰娴嬶紝
杩欏鏈湴 vLLM銆丱llama 鏄纭殑銆?
璺敱涓婇厤缃殑鑷畾涔?`headers` 涔熶細涓€骞跺彂閫侊紝鍥犳闇€瑕侀澶栬姹傚ご鐨勭綉鍏冲悓鏍疯兘琚帰娴嬨€?
## 澶辫触琛屼负

绔偣涓嶅彲杈俱€佸瘑閽ヨ鎷掋€佸垪琛ㄦ棤娉曡В鏋愭椂锛屽彧璁板綍涓€鏉″寘鍚矾鐢卞悕涓庡師鍥犵殑璀﹀憡锛屼笉鍋氫换浣曟敼鍔紝涔熶笉浼氶樆濉炲鍏ワ細
鏈彃浠惰繍琛屾椂閰嶇疆宸茬粡淇濆瓨瀹屾瘯銆?
鑻ヤ袱娆″啓鍏ョ珵浜夛紝杩囨湡鐗堟湰鐨勫啓鍏ヤ細琚嫆缁濓紝闅忓悗鐨勬枃妗ｄ簨浠朵細鍩轰簬鏂板€煎啀瑙﹀彂涓€娆℃帰娴嬨€?
## 鐩綍缁撴瀯

```
index.js              Host 鎻掍欢锛氶厤缃洃鍚€佺鐐规帰娴嬨€佸洖鍐?lib/detect.js         绾嚱鏁帮細鍒楄〃瑙ｆ瀽銆佺瓑绾у綊涓€鍖栥€乁RL 涓庤姹傚ご鏋勯€?lib/plan.js           绾嚱鏁帮細鎶婃帰娴嬬粨鏋滃悎骞惰繘宸查厤缃殑妯″瀷琛?test/detect.test.mjs  涓や釜绾ā鍧楃殑鍗曞厓娴嬭瘯
test/plugin.test.mjs  apply() 鐨勮涓烘祴璇曪紙鍚?HMR 浜嬪姟鍦烘櫙锛?test/live-probe.mjs   瀵瑰叕寮€鍒楄〃鐨勫彧璇绘帰娴嬭剼鏈?cordis.patch.yml      鏈寘鎻掑叆鐨?bundle 琛?```

## 杩愯娴嬭瘯

```bash
node --test test/detect.test.mjs test/plugin.test.mjs
```

## 瀹夎

浠ユ湰鍦扮洰褰曟柟寮忓畨瑁呭埌褰撳墠 profile锛?
```
plugin_manager install_bundle target=<鏈洰褰曠粷瀵硅矾寰?
```

鎴栦娇鐢?DSH CLI锛?
```bash
dsh plugin --profile <profile> add ./dsh-model-capability-detector
```

## 宸茬煡杈圭晫

- 鍙鐞?profile 鑷繁灞傚０鏄庣殑璺敱锛沚undle 澹版槑鐨勮矾鐢辩暀缁欏０鏄庢柟缁存姢銆?- 绔偣鏈姭闇茬殑瀛楁淇濇寔鍘熸牱锛屼笉杩涜鎺ㄦ柇銆?- 绾?Host 渚у疄鐜帮紝鏃犵嫭绔?UI锛涚粨鏋滈€氳繃 profile 閰嶇疆涓庢棩蹇椾綋鐜般€?