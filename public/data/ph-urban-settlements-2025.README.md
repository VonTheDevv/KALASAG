# Philippines Urban Settlement Mask 2025

This binary mask is derived from the European Commission Joint Research Centre
Global Human Settlement Layer (GHSL), GHS-SMOD R2023A, epoch 2025, WGS84
30-arcsecond release V2.0.

- Source: `GHS_SMOD_E2025_GLOBE_R2023A_4326_30ss_V2_0.zip`
- Source URL: `https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_SMOD_GLOBE_R2023A/GHS_SMOD_E2025_GLOBE_R2023A_4326_30ss/V2-0/GHS_SMOD_E2025_GLOBE_R2023A_4326_30ss_V2_0.zip`
- Source SHA-256: `3501a7fcb2eefdd247585d8800b759ff1d8d07aeee62a6a5a17cc0a636baccec`
- Output SHA-256: `10fc922960876b8210388f16ec112246973c29f6302f77f6761082ceb54d3527`
- Bounds: 4 to 22 degrees north, 116 to 128 degrees east
- Dimensions: 2160 rows by 1440 columns
- Included classes: 21, 22, 23, and 30 (suburban/peri-urban through urban centre)

The 12-byte `KUS1` header records the format version, resolution, dimensions,
and epoch. The remaining cells are stored as one bit each, north-to-south and
west-to-east. Run `npm run urban-mask:check` to validate the checked-in file.
Regenerate it with:

```sh
npm run urban-mask:build -- /path/to/GHS_SMOD_E2025_GLOBE_R2023A_4326_30ss_V2_0.tif
```

GHSL data is open and free to use with acknowledgment of the source. The mask
provides settlement context only; it does not identify individual homes or
confirm that a satellite thermal anomaly is a structure fire.
