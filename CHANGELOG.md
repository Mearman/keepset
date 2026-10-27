# [0.61.0](https://github.com/Mearman/keepset/compare/v0.60.0...v0.61.0) (2026-10-27)


### Bug Fixes

* **seed:** keep a recorded download size instead of asking the host again ([fe205c5](https://github.com/Mearman/keepset/commit/fe205c58361731c438ef77ab875046d58fcc72ad))


### Features

* **seed:** add the SNAP originals of two SuiteSparse graphs ([e2e867d](https://github.com/Mearman/keepset/commit/e2e867dd3fde6545beb76d1bf7471b96b0bcdd0e))
* **seed:** record what a publisher states about a dataset with no recipe ([6884b79](https://github.com/Mearman/keepset/commit/6884b79d326c185c89e52efd5f17bc03ff05556b))

# [0.60.0](https://github.com/Mearman/keepset/compare/v0.59.0...v0.60.0) (2026-10-27)


### Features

* let an entry name the entries that hold the same data ([409961c](https://github.com/Mearman/keepset/commit/409961c2b4f907bb688c86c141914a41e77fad64))
* **seed:** record which graph entries hold the same data ([6943a5b](https://github.com/Mearman/keepset/commit/6943a5b90e6ec30caf734d613c919e3ca0d2cd8e))

# [0.59.0](https://github.com/Mearman/keepset/compare/v0.58.1...v0.59.0) (2026-10-26)


### Bug Fixes

* **seed:** record the size of the SuiteSparse downloads their captures give ([2d76326](https://github.com/Mearman/keepset/commit/2d76326b4adf23da83b42509e2c608bc245ccbb2))


### Features

* **seed:** offer a SuiteSparse file's Wayback capture ahead of the collection's own link ([038985c](https://github.com/Mearman/keepset/commit/038985cce71c34dae58dfdf7f6253f181681c98e))
* **seed:** pin the Wayback captures of SuiteSparse files the collection no longer serves ([ec3e686](https://github.com/Mearman/keepset/commit/ec3e686f568cbe8b034a6f986570ed2eb07c9562))
* **seed:** size a pinned snapshot that records no length from the snapshot ([0f80077](https://github.com/Mearman/keepset/commit/0f800778be28f94e9a909044d58f0c0c5a5c0b7f))
* **site:** show a paged query's size as paged ([ea85859](https://github.com/Mearman/keepset/commit/ea858590e146f06b62c62fd942b31bf314595074))

## [0.58.1](https://github.com/Mearman/keepset/compare/v0.58.0...v0.58.1) (2026-10-25)


### Bug Fixes

* **seed:** drop error-page download sizes and record the measured ones ([48b7372](https://github.com/Mearman/keepset/commit/48b7372caab6cafa0eadce975ae67fcc8dd7eb69))
* **seed:** ignore the size an error response states and count a body that states none ([1b818da](https://github.com/Mearman/keepset/commit/1b818da9d3a3379b8d6d91d0e5011636710c3d6a))

# [0.58.0](https://github.com/Mearman/keepset/compare/v0.57.0...v0.58.0) (2026-10-24)


### Features

* **seed:** record the download size of task datasets as well as graphs ([f308123](https://github.com/Mearman/keepset/commit/f30812392f7a7db4950cfe530237f69ff416b14c))

# [0.57.0](https://github.com/Mearman/keepset/compare/v0.56.0...v0.57.0) (2026-10-24)


### Features

* **seed:** give every graph a domain and a download size ([0b7b9e5](https://github.com/Mearman/keepset/commit/0b7b9e590fabe8c5797b398e933b2c77569e6578))
* **seed:** take a pinned snapshot's recorded size as the download's size ([0290285](https://github.com/Mearman/keepset/commit/029028595f760d08e685adabef24aaddaaa6cf20))

# [0.56.0](https://github.com/Mearman/keepset/compare/v0.55.0...v0.56.0) (2026-10-24)


### Features

* **seed:** record the rows each open data table held when it was probed ([40edf65](https://github.com/Mearman/keepset/commit/40edf6509723bee2c4e1c0db6f64f18e45f3fc3e))
* **seed:** take a graph's domain and download size from its collection's index ([5b44cb6](https://github.com/Mearman/keepset/commit/5b44cb611c36d8aaab325274bc22721d4f3c24ee))
* **site:** show a probed node count as approximate and prefer the download's size ([429dc8d](https://github.com/Mearman/keepset/commit/429dc8d45b3db99e80b57858d27881716e4f9c6d))

# [0.55.0](https://github.com/Mearman/keepset/compare/v0.54.0...v0.55.0) (2026-10-23)


### Features

* **site:** filter the listing by one entities range in place of node and edge ranges ([2a082ab](https://github.com/Mearman/keepset/commit/2a082ab8a95b1fbf9ddf57095ff887ba9334f258))

# [0.54.0](https://github.com/Mearman/keepset/compare/v0.53.0...v0.54.0) (2026-10-23)


### Features

* **site:** replace the listing's node, edge and instance columns with one entities column ([6b7038f](https://github.com/Mearman/keepset/commit/6b7038f2b340509163d4fff4efc4b68a8f34c31e))

# [0.53.0](https://github.com/Mearman/keepset/compare/v0.52.2...v0.53.0) (2026-10-23)


### Bug Fixes

* **site:** announce the preview's progress and failures and label its file chooser ([f6a48c7](https://github.com/Mearman/keepset/commit/f6a48c7b3e087cd8d7fdee5f6caa298ea76a1855))
* **site:** size the listing's content columns from the data so no count is cut ([90dee68](https://github.com/Mearman/keepset/commit/90dee68eba37ed0709a294239e9f2cbafd6b4bc8))


### Features

* **site:** label the listing's filters and sort its columns from the keyboard ([fed8676](https://github.com/Mearman/keepset/commit/fed86762f12c9cfedc945cfd8e2e72647480047f))
* **site:** lead an entry page with its trail and figures, and write its properties for reading ([2ed405a](https://github.com/Mearman/keepset/commit/2ed405abf7389c872f8dc0649ecc4573bf6ced5a))

## [0.52.2](https://github.com/Mearman/keepset/compare/v0.52.1...v0.52.2) (2026-10-23)

## [0.52.1](https://github.com/Mearman/keepset/compare/v0.52.0...v0.52.1) (2026-10-23)

# [0.52.0](https://github.com/Mearman/keepset/compare/v0.51.4...v0.52.0) (2026-10-23)


### Features

* **site:** link a pinned snapshot with and without the archive banner, each with a copy icon ([abaa6e9](https://github.com/Mearman/keepset/commit/abaa6e9fa545f2559e256de689c4c10f74add1e7))

## [0.51.4](https://github.com/Mearman/keepset/compare/v0.51.3...v0.51.4) (2026-10-22)


### Bug Fixes

* **seed:** carry a pin's checksum over when an import regenerates its entry ([bbe8c3a](https://github.com/Mearman/keepset/commit/bbe8c3a12098476d4443ecf068d99650c75f42d9))

## [0.51.3](https://github.com/Mearman/keepset/compare/v0.51.2...v0.51.3) (2026-10-22)


### Bug Fixes

* **archive:** pace the checksum pass at a read every thirty seconds ([b37a14c](https://github.com/Mearman/keepset/commit/b37a14c98581d4aee48df816e3c4a4795eb690a2))

## [0.51.2](https://github.com/Mearman/keepset/compare/v0.51.1...v0.51.2) (2026-10-22)

## [0.51.1](https://github.com/Mearman/keepset/compare/v0.51.0...v0.51.1) (2026-10-22)


### Bug Fixes

* **site:** fill the service worker's cache from the network, not the HTTP cache ([d8a483b](https://github.com/Mearman/keepset/commit/d8a483b8d1f4b87657af88859d1119003d730473))

# [0.51.0](https://github.com/Mearman/keepset/compare/v0.50.0...v0.51.0) (2026-10-22)


### Features

* **site:** browse every node and edge of a previewed result ([6b9101a](https://github.com/Mearman/keepset/commit/6b9101a5e0229bf685978e808271208ae30ed205))

# [0.50.0](https://github.com/Mearman/keepset/compare/v0.49.6...v0.50.0) (2026-10-22)


### Bug Fixes

* **site:** make the preview worker start and offer the file drop without waiting out retries ([ffd2bd1](https://github.com/Mearman/keepset/commit/ffd2bd10b1591c7bbdb3279257c9d623bc271a30))


### Features

* **site:** load the map and the preview on demand and render only visible listing rows ([062bde2](https://github.com/Mearman/keepset/commit/062bde2b09e7a33ce1d073596362ff3dad4eb890))

## [0.49.6](https://github.com/Mearman/keepset/compare/v0.49.5...v0.49.6) (2026-10-22)


### Bug Fixes

* **archive:** read a replay without a range request ([626cc9c](https://github.com/Mearman/keepset/commit/626cc9c22cea7f4c53d676cc64ccd954a465c056))

## [0.49.5](https://github.com/Mearman/keepset/compare/v0.49.4...v0.49.5) (2026-10-22)


### Bug Fixes

* **archive:** do not hold an HTML page to the source's stated length ([b1151e3](https://github.com/Mearman/keepset/commit/b1151e33fe9068a547f02d5812dde4e081b44527))

## [0.49.4](https://github.com/Mearman/keepset/compare/v0.49.3...v0.49.4) (2026-10-22)


### Bug Fixes

* **archive:** wait out a refused connection and ask the Wayback Machine less often ([f727c46](https://github.com/Mearman/keepset/commit/f727c46c1f9661e3d9e15066c88f4cacfde7d570))

## [0.49.3](https://github.com/Mearman/keepset/compare/v0.49.2...v0.49.3) (2026-10-22)


### Bug Fixes

* **archive:** treat a URL's daily capture limit as that URL's, not the account's ([24dd4a4](https://github.com/Mearman/keepset/commit/24dd4a4b79ae93ee341b337da4cf896dfe0c4ae9))

## [0.49.2](https://github.com/Mearman/keepset/compare/v0.49.1...v0.49.2) (2026-10-22)


### Bug Fixes

* **archive:** stop a run on Wayback Machine trouble only ([8ccbb98](https://github.com/Mearman/keepset/commit/8ccbb98d8b20d55a48358ef59b9d4a88b132fc79))

## [0.49.1](https://github.com/Mearman/keepset/compare/v0.49.0...v0.49.1) (2026-10-22)


### Bug Fixes

* **archive:** record a URL whose captures the Wayback Machine will not serve back ([e8e8f53](https://github.com/Mearman/keepset/commit/e8e8f53cd69a9ea33c837b03cc98cc7bf8dede6c))

# [0.49.0](https://github.com/Mearman/keepset/compare/v0.48.1...v0.49.0) (2026-10-22)


### Features

* **archive:** settle several URLs at once ([66fbf32](https://github.com/Mearman/keepset/commit/66fbf3222774f79d45821ebb581479788a55d297))

## [0.48.1](https://github.com/Mearman/keepset/compare/v0.48.0...v0.48.1) (2026-10-21)


### Bug Fixes

* **archive:** try URLs that ended unresolved after the ones that can be settled ([9287cd1](https://github.com/Mearman/keepset/commit/9287cd133f4e07a35797170b941b4b8716ff4648))

# [0.48.0](https://github.com/Mearman/keepset/compare/v0.47.1...v0.48.0) (2026-10-21)


### Features

* **archive:** record and display a checksum for each pinned snapshot ([87e7483](https://github.com/Mearman/keepset/commit/87e7483f007748a7e743ad87b99e0b616107c937))

## [0.47.1](https://github.com/Mearman/keepset/compare/v0.47.0...v0.47.1) (2026-10-21)


### Bug Fixes

* **archive:** pin the capture a fresh capture's replay answers from ([b1e4c68](https://github.com/Mearman/keepset/commit/b1e4c68dac21a8de2b1648923302cca745122bf1))

# [0.47.0](https://github.com/Mearman/keepset/compare/v0.46.1...v0.47.0) (2026-10-21)


### Bug Fixes

* **archive:** pace the Wayback Machine's hosts at a request every five seconds ([511951d](https://github.com/Mearman/keepset/commit/511951d984f0ed906e8a438df09466c15bbbcd1f))


### Features

* **site:** show dataset dimensions in the listing with sorting and range filters ([b415770](https://github.com/Mearman/keepset/commit/b41577047c1d9b5f36bf4645a6d2f9eaf91279f7))

## [0.46.1](https://github.com/Mearman/keepset/compare/v0.46.0...v0.46.1) (2026-10-21)


### Bug Fixes

* **archive:** look up existing snapshots through the capture index ([a6ee979](https://github.com/Mearman/keepset/commit/a6ee97966494e2ba96948cbd462f6dc2e9d98890))

# [0.46.0](https://github.com/Mearman/keepset/compare/v0.45.0...v0.46.0) (2026-10-21)


### Features

* **fetch:** resolve sources through the Wayback Machine and contribute a capture ([cbe4cb0](https://github.com/Mearman/keepset/commit/cbe4cb0476458fd9babc7fa2c6491517a095ef6c))

# [0.45.0](https://github.com/Mearman/keepset/compare/v0.44.0...v0.45.0) (2026-10-21)


### Features

* **site:** plot a result's points on a map or a plane in the preview ([af99983](https://github.com/Mearman/keepset/commit/af99983dc059c8807315856e60f09957b0f9e851))

# [0.44.0](https://github.com/Mearman/keepset/compare/v0.43.0...v0.44.0) (2026-10-21)


### Features

* **site:** fetch and preview a dataset on its entry page ([c8d44e6](https://github.com/Mearman/keepset/commit/c8d44e6e370b97a105ef37c8444e98be6a8956d7))

# [0.43.0](https://github.com/Mearman/keepset/compare/v0.42.0...v0.43.0) (2026-10-21)


### Features

* **browser:** a keepset/browser entry point over the neutral fetch core ([252a350](https://github.com/Mearman/keepset/commit/252a3502df24f65002c304c9b9ff286bd2d52c57))

# [0.42.0](https://github.com/Mearman/keepset/compare/v0.41.1...v0.42.0) (2026-10-21)


### Features

* **sources:** hash what a source serves and check its mirrors ([87f1f69](https://github.com/Mearman/keepset/commit/87f1f69cf404c66137c414f6cbd9ee3ff6a715eb))

## [0.41.1](https://github.com/Mearman/keepset/compare/v0.41.0...v0.41.1) (2026-10-21)


### Bug Fixes

* **archive:** read a report written before verification existed ([4bc1cc2](https://github.com/Mearman/keepset/commit/4bc1cc2f3e82d11db6a3a76d9acbf3b4968d2a80))

# [0.41.0](https://github.com/Mearman/keepset/compare/v0.40.0...v0.41.0) (2026-10-21)


### Features

* **archive:** verify a snapshot serves its bytes before pinning it ([19f1a61](https://github.com/Mearman/keepset/commit/19f1a61455c2ee3acceb54a5548389690c056b60))

# [0.40.0](https://github.com/Mearman/keepset/compare/v0.39.0...v0.40.0) (2026-10-21)


### Bug Fixes

* **catalogue:** number the NYPD calls rows, whose event id repeats ([08b8c03](https://github.com/Mearman/keepset/commit/08b8c0303f3b6a60112bcd4c9fe1e71bf1f881f4))
* reconcile the streamed and files recipes with parts archives ([cd8d283](https://github.com/Mearman/keepset/commit/cd8d283cf965a4e4062d7c39a946a182bbfb13a3))


### Features

* **catalogue:** stream the large NYC Open Data tables ([1385126](https://github.com/Mearman/keepset/commit/138512624a235a7d9bbcea53c5eae26d06f11e64))
* **cli:** stream a streamed entry's fetch into its file ([645411b](https://github.com/Mearman/keepset/commit/645411b54d5c948b1a3df5305a064ae658861105))
* **node:** stream a table too large to hold as one document ([2484750](https://github.com/Mearman/keepset/commit/248475054d7f5c2d8c3b13457de0849e1f834e87))
* **parsers:** read Mankowska, VeRoLog 2017 and technician dispatch instance files ([0233108](https://github.com/Mearman/keepset/commit/023310804ea20bec3e672dcd4748ad4458274787))
* read collections of separate downloads, breaking the Provenance type ([5b18ada](https://github.com/Mearman/keepset/commit/5b18adaf186d6263f99e453923b328bb6d40ac12))
* **seed:** curate collections of separate files and scale instance durations ([15eff66](https://github.com/Mearman/keepset/commit/15eff66919959a05a7c9ad983a8fac9efa485f19))
* **seed:** stream paged tables too long to hold and select Socrata fields ([d7cc2e8](https://github.com/Mearman/keepset/commit/d7cc2e8abe8100949ff1ad3780d8c84dba8b7acd))
* **seed:** verify streamed recipes and report what a fetch held ([7d0c9be](https://github.com/Mearman/keepset/commit/7d0c9be53f23866ff28e366589157bbd29feb373))

# [0.39.0](https://github.com/Mearman/keepset/compare/v0.38.0...v0.39.0) (2026-10-21)


### Features

* **catalogue:** fetch the OGB, SNAP signed, STRING, BioGRID, e-mail and airline graph entries ([6432ef3](https://github.com/Mearman/keepset/commit/6432ef3b11282444f4deae0ded62c17e841b0d86))
* **parsers:** read edge lists in pieces and keep only lines meeting where conditions ([ddda9a0](https://github.com/Mearman/keepset/commit/ddda9a0bfc68017eff55a6ba1c1b04ef466ab5bc))
* **parsers:** read Open Graph Benchmark raw directories from a files archive ([ebbc123](https://github.com/Mearman/keepset/commit/ebbc1231fb421a2cecb22ae34080696443e130f9))

# [0.38.0](https://github.com/Mearman/keepset/compare/v0.37.1...v0.38.0) (2026-10-21)


### Bug Fixes

* **parsers:** read a zero multiplicity as a line with no edges ([013122e](https://github.com/Mearman/keepset/commit/013122e27287551f13b2a75779f1c2d6ffb11493))


### Features

* **archive:** read legacy xls and OpenDocument spreadsheets as sheets ([60f61bd](https://github.com/Mearman/keepset/commit/60f61bd2fa43f20877bd3ab7af37298091225211))
* **parsers:** filter, count and fold mirrored lines in an edge list ([ae0c2e4](https://github.com/Mearman/keepset/commit/ae0c2e45613783d05190b34ac4508c60dc359344))
* **parsers:** read Witvliet connectome synapse files ([be53e72](https://github.com/Mearman/keepset/commit/be53e72cd67202f2a53f0792d88a5e22274bf54d))
* **seed:** give the WormAtlas and WormWiring connectomes recipes ([678382a](https://github.com/Mearman/keepset/commit/678382a1e371e3961f1d8552a3469b775595cfbe))
* **seed:** read the Perm sites workbook and the flood warnings table ([4dbf752](https://github.com/Mearman/keepset/commit/4dbf75287d75e82dc1f3bdaa0d42d384cdbd3fb8))

## [0.37.1](https://github.com/Mearman/keepset/compare/v0.37.0...v0.37.1) (2026-10-21)

# [0.37.0](https://github.com/Mearman/keepset/compare/v0.36.0...v0.37.0) (2026-10-21)


### Bug Fixes

* **catalogue:** give no recipe to the triples too large for one fetch ([101782d](https://github.com/Mearman/keepset/commit/101782d6d9e47a357369e48ad7135ba237b7b22b)), closes [ExaDev/crossmap#57](https://github.com/ExaDev/crossmap/issues/57)
* **catalogue:** read YAGO3-10 and correct the triples and HGB records afresh ([c0cfaff](https://github.com/Mearman/keepset/commit/c0cfaff712bb493d0ccbcb37cbb7fdb0d833a43e))


### Features

* **catalogue:** give the knowledge graph, HGB and Last.fm entries recipes ([802cea4](https://github.com/Mearman/keepset/commit/802cea4be4313ffebd81c3a89b2f2d08e89db8e4))
* **parsers:** read knowledge graph triples, HGB datasets and user-item counts ([5f283b1](https://github.com/Mearman/keepset/commit/5f283b178e01a99a2b715f9c72cc8f56115a32ff))

# [0.36.0](https://github.com/Mearman/keepset/compare/v0.35.0...v0.36.0) (2026-10-21)


### Bug Fixes

* **seed:** refresh the pipeline catalogue copy and regenerate the graph entries ([95ff983](https://github.com/Mearman/keepset/commit/95ff98380d3d85823b7748a2ae5d37140b537dbe)), closes [#116](https://github.com/Mearman/keepset/issues/116)


### Features

* **seed:** fetch SuiteSparse matrices from the University of Florida mirror ([36d855d](https://github.com/Mearman/keepset/commit/36d855d67ea794f6f59ecc8f67dfdb61373a1231)), closes [#115](https://github.com/Mearman/keepset/issues/115)
* **seed:** read homepage sources and a download's endpoint columns and header lines ([ad56654](https://github.com/Mearman/keepset/commit/ad566541c033b39e2bf268475b1e927adf9116cc))

# [0.35.0](https://github.com/Mearman/keepset/compare/v0.34.0...v0.35.0) (2026-10-21)


### Bug Fixes

* **catalogue:** name the distance matrices among the concrete delivery arrays ([15e6ab1](https://github.com/Mearman/keepset/commit/15e6ab13ebc9b919d027d064cde11a84b1a5215f))
* **catalogue:** state why the concrete delivery and SRU notice entries are not fetchable ([cc5dd0d](https://github.com/Mearman/keepset/commit/cc5dd0d43c36df0a431982dd6b0a11935febde09))


### Features

* **archive:** read every sheet of a collection's workbooks as an instance ([c8bf0a0](https://github.com/Mearman/keepset/commit/c8bf0a0993b13aa9ef8abe79b07a8ba9d4013b45))
* **archive:** read zipped point shapefiles as tables ([31c3187](https://github.com/Mearman/keepset/commit/31c3187b6cb4ba49a9d53ce36409bd2851649a57))
* **catalogue:** fetch the home health care routing workbooks ([8e1b2b7](https://github.com/Mearman/keepset/commit/8e1b2b742c34b3f444d3538ac4fc158c2aec724b))
* **catalogue:** fetch the Sitadel housing permits shapefile ([487f665](https://github.com/Mearman/keepset/commit/487f665a19c030d6db6b0e97722d4d6ff81b9ac2))
* **parsers:** read home health care routing sheets ([26f5b4f](https://github.com/Mearman/keepset/commit/26f5b4fb236a9d84e27a6b67f1b76f07247883c5))

# [0.34.0](https://github.com/Mearman/keepset/compare/v0.33.0...v0.34.0) (2026-10-21)


### Bug Fixes

* **catalogue:** carry the topology crosswalk for the GD contest recipe ([ca2b4a8](https://github.com/Mearman/keepset/commit/ca2b4a81bb42f0d842e2f6dc2dfda8fe580974bc))
* **catalogue:** give no recipe to a release too large for one fetch ([08ef32a](https://github.com/Mearman/keepset/commit/08ef32a8430ce53640f0f5091f71fd7d9c365b88)), closes [ExaDev/crossmap#57](https://github.com/ExaDev/crossmap/issues/57)


### Features

* **archive:** read bzip2 files and tar.bz2 archives ([485150a](https://github.com/Mearman/keepset/commit/485150a3b7191908406d32859cf7879391692612))
* **catalogue:** give the Amazon, MovieLens and KONECT entries recipes ([5050678](https://github.com/Mearman/keepset/commit/505067898e406f876a38a2dcf2c5059be9f00dff))
* **parsers:** read KONECT edge files with their weights and times ([a7ed605](https://github.com/Mearman/keepset/commit/a7ed60554f0bfe6f44a4b5a0d34e295fccd590b5))
* **parsers:** read user-item rating files as a bipartite graph ([9bec744](https://github.com/Mearman/keepset/commit/9bec744d5deab5df620e816e38946839e956c786))

# [0.33.0](https://github.com/Mearman/keepset/compare/v0.32.0...v0.33.0) (2026-10-20)


### Features

* **seed:** record where each graph dataset's licence was read ([cbee33a](https://github.com/Mearman/keepset/commit/cbee33a71295889b317bf4717ce05585918c919d))
* **seed:** record where each operations-research item's licence was read ([174a331](https://github.com/Mearman/keepset/commit/174a33179c213ebf37bb838c2cb161b42cd85497))

# [0.32.0](https://github.com/Mearman/keepset/compare/v0.31.0...v0.32.0) (2026-10-20)


### Features

* **archive:** unpack a member that is itself an archive ([1f34637](https://github.com/Mearman/keepset/commit/1f34637695207bd4dec115323c87cb782e501df6))
* **catalogue:** fetch the UCINet and GD 2004 graph entries ([7a3e0b2](https://github.com/Mearman/keepset/commit/7a3e0b2712a52ba6db7dfd93313aa9dee96d5e2a))
* **parsers:** read Graph Drawing contest files ([8c34d01](https://github.com/Mearman/keepset/commit/8c34d01a9500884eb8f5315b68474817661507d4))
* **parsers:** read UCINet DL full matrices ([b13df0d](https://github.com/Mearman/keepset/commit/b13df0d12e066bc394894c2d23660ec3db06317d))

# [0.31.0](https://github.com/Mearman/keepset/compare/v0.30.0...v0.31.0) (2026-10-20)


### Bug Fixes

* **seed:** keep archived snapshots when an import rewrites an entry ([98d234f](https://github.com/Mearman/keepset/commit/98d234fe3cabb82924fc8b9301d5ee6cc40655ab))


### Features

* **scripts:** archive source URLs on the Wayback Machine ([e3b8a7e](https://github.com/Mearman/keepset/commit/e3b8a7e657823f6b92c4b85b3254f24e01853842))
* **scripts:** check recorded sources for liveness on a schedule ([c63ccd5](https://github.com/Mearman/keepset/commit/c63ccd5a9eeebf9cb6108561cabd948332f7ea4f))

# [0.30.0](https://github.com/Mearman/keepset/compare/v0.29.3...v0.30.0) (2026-10-20)


### Features

* **catalogue:** describe and cite the tasks entries ([5d05ad2](https://github.com/Mearman/keepset/commit/5d05ad20e766df38f38ae2981af9f04a39de882a)), closes [#106](https://github.com/Mearman/keepset/issues/106) [#107](https://github.com/Mearman/keepset/issues/107)
* **catalogue:** refuse entries whose names a listing cannot tell apart ([517cb99](https://github.com/Mearman/keepset/commit/517cb99056fced3b86d352cf0ef40276bc45c5ae)), closes [#108](https://github.com/Mearman/keepset/issues/108)

## [0.29.3](https://github.com/Mearman/keepset/compare/v0.29.2...v0.29.3) (2026-10-20)


### Bug Fixes

* **deps:** depend on crossmap, the renamed crosswalk codec, instead of twindex ([a75eda3](https://github.com/Mearman/keepset/commit/a75eda33df462cc6cd0278325b37b0d90756415d))

## [0.29.2](https://github.com/Mearman/keepset/compare/v0.29.1...v0.29.2) (2026-10-20)

## [0.29.1](https://github.com/Mearman/keepset/compare/v0.29.0...v0.29.1) (2026-10-20)

# [0.29.0](https://github.com/Mearman/keepset/compare/v0.28.1...v0.29.0) (2026-10-20)


### Features

* **catalogue:** file the operations research survey under its subject ([55e76f3](https://github.com/Mearman/keepset/commit/55e76f3d6adf217262c7be82ec900479c053d7d7))
* **entry:** add the subjects an entry is relevant to ([2e2f7d1](https://github.com/Mearman/keepset/commit/2e2f7d11d54f738c446f29c8c1a7e14833d8fd21))
* **site:** list datasets by subject ([4641c1b](https://github.com/Mearman/keepset/commit/4641c1b20048f84332f07241004554f913fd6433))

## [0.28.1](https://github.com/Mearman/keepset/compare/v0.28.0...v0.28.1) (2026-10-20)

# [0.28.0](https://github.com/Mearman/keepset/compare/v0.27.1...v0.28.0) (2026-10-20)


### Features

* **catalogue:** fetch the facility work orders and name the VA obstacle ([87a3cdd](https://github.com/Mearman/keepset/commit/87a3cddc6b5312d9f85f3156c3cc310ab458ecf6))

## [0.27.1](https://github.com/Mearman/keepset/compare/v0.27.0...v0.27.1) (2026-10-20)


### Bug Fixes

* **exports:** export the or-set/v1 target and the collection types ([8af8616](https://github.com/Mearman/keepset/commit/8af861626ca9e382be9e58f206074f6b55f5bded))

# [0.27.0](https://github.com/Mearman/keepset/compare/v0.26.0...v0.27.0) (2026-10-20)


### Features

* **archive:** select members by a pattern their path matches ([a07c883](https://github.com/Mearman/keepset/commit/a07c8830cc4999f1e8c21b288e1095f12c5b614d))
* **catalogue:** fetch the Hartford meter reading customers ([d9525bf](https://github.com/Mearman/keepset/commit/d9525bf8f55c76ee3d3dd1f7a325be3dad8d7e32))
* **catalogue:** fetch the park and loop routing client locations ([bdd2e0a](https://github.com/Mearman/keepset/commit/bdd2e0a31766d2bebe0f14f5986e2d2b4819edb9))
* **catalogue:** fetch the technician routing collections ([3360946](https://github.com/Mearman/keepset/commit/33609463bbf14d68266b84b0ecc2bf3f6778090d))
* **parsers:** read customer points files ([6572710](https://github.com/Mearman/keepset/commit/6572710a73d64a91d65619f9777376f869bf4aee))
* **parsers:** read VeRoLog 2019 technician routing instances ([29655b0](https://github.com/Mearman/keepset/commit/29655b0b53534970c4f9962e6cc64b222e0e15c4))
* **parsers:** read VRP-REP XML instances ([b4aff77](https://github.com/Mearman/keepset/commit/b4aff77b43a59faf9908376795dc85a229c270e4))
* **seed:** import a collection of table files from the or survey ([4409a63](https://github.com/Mearman/keepset/commit/4409a6331632ed19f4f73d2e33925427ec3ffd82))
* **seed:** import one instance file as an or/v1 document ([57f9344](https://github.com/Mearman/keepset/commit/57f934421c08ba1dd07e0d591905b4d606976ec4))

# [0.26.0](https://github.com/Mearman/keepset/compare/v0.25.0...v0.26.0) (2026-10-20)


### Bug Fixes

* **download:** send an Accept header ([ead4f99](https://github.com/Mearman/keepset/commit/ead4f993215697db96b98c91457237a6cdf9646a))


### Features

* **catalogue:** fetch the VRP-REP orienteering instance collections ([0f01449](https://github.com/Mearman/keepset/commit/0f01449db73eb5c92b751442cd7d7f52b0fcc364))
* **parsers:** read TSPLIB probabilistic and clustered orienteering files ([39357ee](https://github.com/Mearman/keepset/commit/39357ee6bc572347bb204d45581468dee1f6d4d5))

# [0.25.0](https://github.com/Mearman/keepset/compare/v0.24.0...v0.25.0) (2026-10-20)


### Features

* **catalogue:** fetch the KU Leuven orienteering instance collections ([f0b7b1b](https://github.com/Mearman/keepset/commit/f0b7b1bd4a8696aee17df6fb69e42797c06d9d88))
* **parsers:** read TOPTW and team orienteering instance files ([fd947a3](https://github.com/Mearman/keepset/commit/fd947a3feca6fcab3b4927de29c4b30aeb75391d))

# [0.24.0](https://github.com/Mearman/keepset/compare/v0.23.0...v0.24.0) (2026-10-20)


### Features

* **catalogue:** fetch the Solomon and Tenerife vehicle routing collections ([3d6db11](https://github.com/Mearman/keepset/commit/3d6db11b6e744a63ef970b20e9d3b7ee506fa731))
* **categories:** read a collection of instance files as or-set/v1 ([8880ac8](https://github.com/Mearman/keepset/commit/8880ac8fa122b65a95b5d785761eb8f403f032d5))
* **seed:** import a collection of instance files from the or survey ([cf2aca6](https://github.com/Mearman/keepset/commit/cf2aca67113119281a4038134bad1fb660a7c8d6))

# [0.23.0](https://github.com/Mearman/keepset/compare/v0.22.1...v0.23.0) (2026-10-20)


### Features

* **catalogue:** fetch the FEMA flood insurance claims ([216e9bc](https://github.com/Mearman/keepset/commit/216e9bc6f6cdfdc303c156a4ee7ae250ce494bc2))
* **parsers:** page an OpenFEMA entity and check each page ([58d6a57](https://github.com/Mearman/keepset/commit/58d6a575107c5ea97da5b1a1cf390b33e4b85b2d))
* **seed:** page OpenFEMA sources and raise the cell limit to what was measured ([911ada4](https://github.com/Mearman/keepset/commit/911ada44ac75a363b9d13fa425319587bdf42068))

## [0.22.1](https://github.com/Mearman/keepset/compare/v0.22.0...v0.22.1) (2026-10-20)

# [0.22.0](https://github.com/Mearman/keepset/compare/v0.21.0...v0.22.0) (2026-10-20)


### Features

* **catalogue:** fetch more open data tables and correct the reasons left ([d6e3e4a](https://github.com/Mearman/keepset/commit/d6e3e4a8dfb206ee15a12b3a7f2eaa368d9e9b8b))
* **parsers:** page a CKAN datastore dump and read NA as a missing value ([216d9fa](https://github.com/Mearman/keepset/commit/216d9fae6b714584de6ceb1dedc3216e4bb2be61))
* **seed:** import archived and CKAN sources and verify paged ones whole ([60fcb59](https://github.com/Mearman/keepset/commit/60fcb5958397b2d9e5b072f6e77a4b53cf737643))

# [0.21.0](https://github.com/Mearman/keepset/compare/v0.20.0...v0.21.0) (2026-10-20)


### Bug Fixes

* **node:** give up a download whose connection sends nothing ([688e314](https://github.com/Mearman/keepset/commit/688e314590aefa7bd4164c9f3ae63fa934f30dab))


### Features

* **catalogue:** fetch the large operations research tables a page at a time ([5997b36](https://github.com/Mearman/keepset/commit/5997b36c069251db4af0a6aded306b2359fdbd08))
* **node:** try a download again when its connection fails ([8beef2b](https://github.com/Mearman/keepset/commit/8beef2b24978c71f548b2483743231f8104259e2))
* **parsers:** ask a page of a paged download again when it fails ([c151a62](https://github.com/Mearman/keepset/commit/c151a627d5f6c7bfb45642cecb5fcb756eb89199))
* **parsers:** read a Socrata resource a page at a time and check each page ([8d158f1](https://github.com/Mearman/keepset/commit/8d158f1d3b64c2f2f99513ff6d74d4e2a33348ae))
* **seed:** bound a table by its kept cells and page a Socrata resource ([bf13cf5](https://github.com/Mearman/keepset/commit/bf13cf5b4fd4eb3613f6763bae0a40f3f169fe03))

# [0.20.0](https://github.com/Mearman/keepset/compare/v0.19.0...v0.20.0) (2026-10-19)


### Features

* **catalogue:** fetch the Environment Agency prosecutions workbook ([bea8a9f](https://github.com/Mearman/keepset/commit/bea8a9f493a9d3e3e582a1400ff581b3ec35e609))
* **parsers:** read a sheet of an xlsx workbook as a table ([2bfa6ab](https://github.com/Mearman/keepset/commit/2bfa6ab19838e861833fd37e66c25240d9eb59c7))
* **seed:** import a workbook sheet as an operations research recipe ([7740b9e](https://github.com/Mearman/keepset/commit/7740b9ebfe151d4ef5ad2a3cae1ed9169c9998fc))

# [0.19.0](https://github.com/Mearman/keepset/compare/v0.18.0...v0.19.0) (2026-10-19)


### Features

* **catalogue:** fetch the ArcGIS operations research layers ([0c4119c](https://github.com/Mearman/keepset/commit/0c4119c18d5bf5e90928c965fcfe0b96a9a512db))
* **parsers:** read an ArcGIS feature layer, a page at a time, as GeoJSON ([13ddf46](https://github.com/Mearman/keepset/commit/13ddf469160c5bf5ee84bbe56a4b0b78ee6adcbf))
* **seed:** import an ArcGIS layer as an operations research recipe ([e86f6b2](https://github.com/Mearman/keepset/commit/e86f6b22907947aa9b634c43c41fc799c05a2930))

# [0.18.0](https://github.com/Mearman/keepset/compare/v0.17.0...v0.18.0) (2026-10-19)


### Bug Fixes

* **seed:** take the range of a column without spreading it into a call ([4f3fc53](https://github.com/Mearman/keepset/commit/4f3fc53d4f364c2d3483c977ca177478388d241b))


### Features

* **catalogue:** read only the mapped columns of each operations research table ([f55eb68](https://github.com/Mearman/keepset/commit/f55eb68ebe1eed3b33f1377064e82405d044f7ef))
* **parsers:** keep only the listed columns and read a table a piece at a time ([18eb4dc](https://github.com/Mearman/keepset/commit/18eb4dc61802ddd277b0af4c43aaa1a67a7dfdfe))
* **seed:** import each operations research recipe with the columns it maps ([e08d1e8](https://github.com/Mearman/keepset/commit/e08d1e8c253da8a8a7f2edc22a1b548bb206959d))

# [0.17.0](https://github.com/Mearman/keepset/compare/v0.16.1...v0.17.0) (2026-10-19)


### Features

* **catalogue:** record expected counts for the fixed operations research sources ([bb11828](https://github.com/Mearman/keepset/commit/bb118288131846d260607205bd345b728d5b9372))
* **seed:** record a fixed source's node count as the entry's expected count ([16e9efb](https://github.com/Mearman/keepset/commit/16e9efb0d4683da41c9ec0733271ab8cf5a15254))

## [0.16.1](https://github.com/Mearman/keepset/compare/v0.16.0...v0.16.1) (2026-10-19)

# [0.16.0](https://github.com/Mearman/keepset/compare/v0.15.1...v0.16.0) (2026-10-19)


### Features

* **seed:** let or-verify fetch a whole download ([4daeaba](https://github.com/Mearman/keepset/commit/4daeabada3353025e9cdb592686a593b7b8ae67a))

## [0.15.1](https://github.com/Mearman/keepset/compare/v0.15.0...v0.15.1) (2026-10-19)


### Bug Fixes

* **catalogue:** correct the operations research recipes a whole fetch refused ([588f93b](https://github.com/Mearman/keepset/commit/588f93b046281a6f3c52cec0e750d8dd710135a8))
* **seed:** ask a Socrata resource endpoint for the whole table ([85ac53b](https://github.com/Mearman/keepset/commit/85ac53bc4599b4881982a2234b9aa651d506e7d0))

# [0.15.0](https://github.com/Mearman/keepset/compare/v0.14.1...v0.15.0) (2026-10-19)


### Bug Fixes

* name an empty table header cell by its position ([83b14ab](https://github.com/Mearman/keepset/commit/83b14ab488df8377a8c590068f96820c41487904))
* reserve id for the row's id in the table parser ([82f8995](https://github.com/Mearman/keepset/commit/82f8995475654340ec6deebf2e8e8d473188e285))


### Features

* **catalogue:** import the operations research dataset survey ([a7789c9](https://github.com/Mearman/keepset/commit/a7789c9783568cfc6a94c05c89b4802a35efa52e))
* **seed:** add the operations-research survey import ([6684081](https://github.com/Mearman/keepset/commit/6684081ae960bfe0a1b1c19b2a85d5adde46b9ff))

## [0.14.1](https://github.com/Mearman/keepset/compare/v0.14.0...v0.14.1) (2026-10-19)

# [0.14.0](https://github.com/Mearman/keepset/compare/v0.13.1...v0.14.0) (2026-10-19)


### Features

* add the or/v1 category for operations-research instances ([69b2f9a](https://github.com/Mearman/keepset/commit/69b2f9add70124f3ea539c1b34d67787d5ca83ab))
* read delimited tables with a csv-table parser ([9b42a5f](https://github.com/Mearman/keepset/commit/9b42a5ff284f12aa6e90718302d4bc0744c9bb5c))

## [0.13.1](https://github.com/Mearman/keepset/compare/v0.13.0...v0.13.1) (2026-10-19)


### Bug Fixes

* **deps:** bump zod and twindex together ([df88ea7](https://github.com/Mearman/keepset/commit/df88ea7ec993d4b7f9ce661272f48b10c8d66e71))

# [0.13.0](https://github.com/Mearman/keepset/compare/v0.12.0...v0.13.0) (2026-10-19)


### Features

* **cli:** add a namespaces command to browse the namespace tree ([a5e84af](https://github.com/Mearman/keepset/commit/a5e84af788734fd0690fb62aa8d56d618c97627c))
* **site:** add a page for every namespace and link the groups ([9f41789](https://github.com/Mearman/keepset/commit/9f41789612d6b2fd8b0af4b283eee71c44504fd2))

# [0.12.0](https://github.com/Mearman/keepset/compare/v0.11.0...v0.12.0) (2026-10-19)


### Features

* let an alias be a path that files the entry in another group ([151d4b8](https://github.com/Mearman/keepset/commit/151d4b812f9da399b496e9679c44d67e2c2a02d7))
* list namespaces and let the manifest alias their segments ([e236acb](https://github.com/Mearman/keepset/commit/e236acbe29a699ff83907f1119d04d03f0d535c3))
* **seed:** alias the collection namespaces by their id abbreviations ([03fb589](https://github.com/Mearman/keepset/commit/03fb589e82afd9e1fc5285f445cad7cead528378))

# [0.11.0](https://github.com/Mearman/keepset/compare/v0.10.0...v0.11.0) (2026-10-19)


### Features

* **cli:** take a qualified name or alias for any dataset ([f350b85](https://github.com/Mearman/keepset/commit/f350b85ce2ed799f344a285ed0eaabf707fd88df))
* resolve datasets by namespace-qualified name and alias ([bcf9a6e](https://github.com/Mearman/keepset/commit/bcf9a6e792fee5955224120f0375fd53a4bf6b22))
* **seed:** file collection-prefixed ids under namespaces ([d1cde50](https://github.com/Mearman/keepset/commit/d1cde502bf4d3af50376dd1caa1e4bf802951bb8))
* **site:** show namespaces and aliases and search by them ([8238292](https://github.com/Mearman/keepset/commit/8238292d9c429b9b44bf1b87c6af0fd27622026c))

# [0.10.0](https://github.com/Mearman/keepset/compare/v0.9.2...v0.10.0) (2026-10-19)


### Features

* **site:** keep home listing rows on one line ([9a1de89](https://github.com/Mearman/keepset/commit/9a1de898229c1ae487f13548bf10d803c14c223b))

## [0.9.2](https://github.com/Mearman/keepset/compare/v0.9.1...v0.9.2) (2026-10-19)


### Bug Fixes

* **site:** name the service worker cache for the precached bytes ([2628f4a](https://github.com/Mearman/keepset/commit/2628f4a783123d0b626d8a0597f06a551433425c))

## [0.9.1](https://github.com/Mearman/keepset/compare/v0.9.0...v0.9.1) (2026-10-19)


### Bug Fixes

* **site:** make static tables share the island's scale and fix light-mode tokens ([1c5663d](https://github.com/Mearman/keepset/commit/1c5663d0ed10fbde5d12ab973dc1e8fec4e3edaf))

# [0.9.0](https://github.com/Mearman/keepset/compare/v0.8.0...v0.9.0) (2026-10-19)


### Features

* **site:** responsive layout with dark-mode tokens ([d7e797b](https://github.com/Mearman/keepset/commit/d7e797b5604d3dfffcfc41b6630b009eb069e4a1))

# [0.8.0](https://github.com/Mearman/keepset/compare/v0.7.0...v0.8.0) (2026-10-18)


### Features

* rebuild the site island on React, Mantine and vanilla-extract ([3e89847](https://github.com/Mearman/keepset/commit/3e898477a767bf9239455b53c5db86099a1e85ac))

# [0.7.0](https://github.com/Mearman/keepset/compare/v0.6.2...v0.7.0) (2026-10-18)


### Features

* seed the operations-research survey as a catalogue source ([e3b9ec1](https://github.com/Mearman/keepset/commit/e3b9ec173e53e14af7ca23206872f60f4706ec67))

## [0.6.2](https://github.com/Mearman/keepset/compare/v0.6.1...v0.6.2) (2026-10-18)

## [0.6.1](https://github.com/ExaDev/keepset/compare/v0.6.0...v0.6.1) (2026-10-18)

# [0.6.0](https://github.com/ExaDev/keepset/compare/v0.5.0...v0.6.0) (2026-10-18)


### Features

* generate the static catalogue site with schema.org Dataset JSON-LD ([09cef1e](https://github.com/ExaDev/keepset/commit/09cef1ec1144572a29ed725e032b94107118ddd7))

# [0.5.0](https://github.com/ExaDev/keepset/compare/v0.4.0...v0.5.0) (2026-10-18)


### Features

* add the keepset command with search, show, fetch, validate and roundtrip ([26ed58d](https://github.com/ExaDev/keepset/commit/26ed58df237518d9eb63500f391bde5c2cb57468)), closes [#11](https://github.com/ExaDev/keepset/issues/11)
* add validateDataset and roundTripEntry to the library ([ba4f7ed](https://github.com/ExaDev/keepset/commit/ba4f7ed5fe8701446f4866c2843e8b6215b56298))

# [0.4.0](https://github.com/ExaDev/keepset/compare/v0.3.0...v0.4.0) (2026-10-18)


### Bug Fixes

* download recipe sources byte for byte, never undoing a Content-Encoding ([bb10f03](https://github.com/ExaDev/keepset/commit/bb10f03d8b315564f2d6b91e0bc99fc7ef942ef9))


### Features

* add the seed import from the thesis pipeline's graph catalogue ([8909502](https://github.com/ExaDev/keepset/commit/8909502e374d4da26aca94d7131da9be1a6c04f2))
* let an archive member selector name several extensions ([2c13182](https://github.com/ExaDev/keepset/commit/2c131821ca094d1e57c6336358c8340d16248e40))
* read abbreviated Pajek section keywords ([07bd9a9](https://github.com/ExaDev/keepset/commit/07bd9a90ac9a60cadf424db2d5977e1ca8a17232))
* refine the seed import's recipes against real downloads ([9d0ece3](https://github.com/ExaDev/keepset/commit/9d0ece3cefbe114ab6b1e11b0b2dff11b86a4729))
* seed the graph/v1 catalogue from the thesis pipeline's catalogue ([db1145e](https://github.com/ExaDev/keepset/commit/db1145e4375ccd82c665cf43e380b8abf1cf43f0)), closes [#10](https://github.com/ExaDev/keepset/issues/10)

# [0.3.0](https://github.com/ExaDev/keepset/compare/v0.2.0...v0.3.0) (2026-10-18)


### Features

* add the library core with listDatasets, getDataset and fetchDataset ([ff1c7af](https://github.com/ExaDev/keepset/commit/ff1c7afb5d2de939d8ec0f62ffa11937a46430e6))
* let an edge-list recipe detect its delimiter from the data ([092b354](https://github.com/ExaDev/keepset/commit/092b354000b7501abe92c4125928e9968c9c501b))
* parse edge lists, Matrix Market, GML and Pajek into a native graph ([51f0863](https://github.com/ExaDev/keepset/commit/51f0863d9ade3406c93510c209a44306c6a54d84))

# [0.2.0](https://github.com/ExaDev/keepset/compare/v0.1.0...v0.2.0) (2026-10-18)


### Features

* define the catalogue entry and manifest formats ([a4cec69](https://github.com/ExaDev/keepset/commit/a4cec69482f62f4b6d83c67401e2b4382c887215))
* generate JSON Schemas for the entry and manifest formats ([b9bef25](https://github.com/ExaDev/keepset/commit/b9bef25f75f6bd8b57a0c0178f1329eb20199aeb))
* state the text encoding in every parser of a recipe ([801ec32](https://github.com/ExaDev/keepset/commit/801ec32d79dfc0bd10c8dcec0837ec4a1906d0da))

# [0.1.0](https://github.com/ExaDev/keepset/compare/v0.0.4...v0.1.0) (2026-10-18)


### Features

* add the category registry with the graph/v1 target ([a8795d0](https://github.com/ExaDev/keepset/commit/a8795d0eac3fa3e132b2ed63aa8df7b115e93b7d)), closes [#8](https://github.com/ExaDev/keepset/issues/8)

## [0.0.4](https://github.com/ExaDev/keepset/compare/v0.0.3...v0.0.4) (2026-10-18)

## [0.0.3](https://github.com/ExaDev/keepset/compare/v0.0.2...v0.0.3) (2026-10-18)

## [0.0.2](https://github.com/ExaDev/keepset/compare/v0.0.1...v0.0.2) (2026-10-18)

## [0.0.1](https://github.com/ExaDev/keepset/compare/v0.0.0...v0.0.1) (2026-10-18)
