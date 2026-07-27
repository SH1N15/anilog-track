!macro customInstall
  IfFileExists "$INSTDIR\original-locale.txt" locale_done
  StrCmp $LANGUAGE "2052" locale_chinese locale_english

  locale_chinese:
    FileOpen $0 "$INSTDIR\original-locale.txt" w
    FileWrite $0 "zh-CN"
    FileClose $0
    Goto locale_done

  locale_english:
    FileOpen $0 "$INSTDIR\original-locale.txt" w
    FileWrite $0 "en-US"
    FileClose $0

  locale_done:
!macroend
