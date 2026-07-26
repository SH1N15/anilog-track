!macro customRemoveFiles
  SetOutPath "$TEMP"
  IfFileExists "$INSTDIR\data\*.*" preserve_data remove_all

  preserve_data:
    IfFileExists "$INSTDIR.anilog-data-preserve\*.*" 0 preserve_ready
    DetailPrint "Data preservation directory already exists: $INSTDIR.anilog-data-preserve"
    Abort

  preserve_ready:
    ClearErrors
    Rename "$INSTDIR\data" "$INSTDIR.anilog-data-preserve"
    IfErrors 0 data_preserved
    DetailPrint "Cannot preserve AniLog data directory."
    Abort

  data_preserved:
    RMDir /r "$INSTDIR"
    CreateDirectory "$INSTDIR"
    ClearErrors
    Rename "$INSTDIR.anilog-data-preserve" "$INSTDIR\data"
    IfErrors 0 remove_done
    DetailPrint "Cannot restore AniLog data directory. Backup remains at $INSTDIR.anilog-data-preserve"
    Abort

  remove_all:
    RMDir /r "$INSTDIR"

  remove_done:
!macroend
