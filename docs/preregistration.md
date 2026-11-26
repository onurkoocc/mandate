# Pilot pre-registration digests

This file records SHA-256 digests of the files that fix the rules and the material of the two pilots on the roadmap in the README: the software pilot, working name F3.1, and the operations pilot, working name F3.3. The first four rows are the initial seal: the digests of the two pre-registrations, of the list of per-file digests of the sealed files of the two pilots, and of the encrypted archive that holds those files. Later rows are the digests of annexes to the registrations and of the files those annexes seal. None of these files is in this repository.

A row gives the SHA-256 digest of a file. A row enters `main` through a pull request: the commit that brings the row into `main` records the digest there, and GitHub records when the pull request merged. A file whose SHA-256 matches the row can be verified against the digest published by that time. A row does not show when a measurement was taken; the registrations say what the order of a seal and a measurement rests on. Rows are only added: a row is not changed or removed afterwards. A registration is not changed after its row either: what is added to it or changed in it later is a new dated annex that cites the registration by file name and SHA-256 digest. An annex's row enters `main` through the annex's own pull request, which also adds a row for each file whose digest the annex says enters this file.

## Digests

Each row has a label that is unique in this file and permanent. The permanent identity of a registration is its labelled row together with the file name in that row. The label of an annex to one registration begins with that registration's label, followed by a hyphen. Every other row has a label of its own, and its description says what it is and what it belongs to.

| Label | What the digest is of | File name | SHA-256 |
|---|---|---|---|
| `F3.1` | the pre-registration of the software pilot, F3.1 | `on-kayit-F3.1.md` | `fbfed022a1b00ed94a7c7e937e4c13b3498990829b2bf2c1c657ad6404410392` |
| `F3.3` | the pre-registration of the operations pilot, F3.3 | `on-kayit-F3.3.md` | `e8a3862ef7af45b591a777ce5ae4e31315ffef1677a3cb0359a93aa18bb450f5` |
| `seal-digests` | the initial seal's list of per-file SHA-256 digests of the 56 sealed files of the two pilots | `mühür-özetleri.txt` | `be41e111efc37729d324b209b9da124b214120d5a47c2804dbbbff7894b19ec9` |
| `seal-archive` | the initial seal's encrypted archive, which holds those 56 files | `muhur-arsivi.tar.gpg` | `cf7431c97ce197ee68cac9b4dbbbc4f50777006263a8e9a70ad0574d868d7729` |

## Checking

To check files, put them in one directory, copy the lines of the block below that name them into a text file in that directory (UTF-8 without a byte-order mark, LF line endings), and, from that directory, run `sha256sum -c` on that file. Every copied line must report `OK`; a warning that a line is improperly formatted is a failed check. File names are in Unicode normalization form C: a copy of `mühür-özetleri.txt` whose name is stored in another form may not be found. Each row has one line in the block, and a row added later adds its line at the end of the block.

```
fbfed022a1b00ed94a7c7e937e4c13b3498990829b2bf2c1c657ad6404410392  on-kayit-F3.1.md
e8a3862ef7af45b591a777ce5ae4e31315ffef1677a3cb0359a93aa18bb450f5  on-kayit-F3.3.md
be41e111efc37729d324b209b9da124b214120d5a47c2804dbbbff7894b19ec9  mühür-özetleri.txt
cf7431c97ce197ee68cac9b4dbbbc4f50777006263a8e9a70ad0574d868d7729  muhur-arsivi.tar.gpg
```
