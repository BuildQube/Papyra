## Default Permission

Opening Word documents and PowerPoint decks, and registering fonts for their layout. Pages are served over tauri-plugin-papyra's papyra:// protocol and closed by its `close`, both in `papyra:default`.

#### This default permission set includes the following:

- `allow-open`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`papyra-office:allow-add-font`

</td>
<td>

Enables the add_font command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`papyra-office:deny-add-font`

</td>
<td>

Denies the add_font command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`papyra-office:allow-open`

</td>
<td>

Enables the open command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`papyra-office:deny-open`

</td>
<td>

Denies the open command without any pre-configured scope.

</td>
</tr>
</table>
