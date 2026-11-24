# HomePanel Studio

Design dashboards for wall tablets on a grid, inside Home Assistant. Tablets running the HomePanel app find this
add-on on the network, wait for your approval, then draw the design you give them.

## Use

1. Start the add-on and open **HomePanel** in the sidebar.
2. Open the HomePanel app on a tablet on the same network. It appears under **Tablets** as waiting.
3. Press **Approve**, then choose a design for it.
4. Open a design to edit it. Drag tiles on the sheet, change their properties on the right, press **Save**.
   Tablets using that design update within a few seconds.

## What it stores

Everything lives in the add-on's own data folder: the tablet list, one file per design, and uploaded pictures.
Tablets never hold a Home Assistant token. They talk to Home Assistant through this add-on with their own key,
which stops working when you remove the tablet.

## Network

The add-on uses the host network on port 8722 and advertises itself over mDNS as `_homepanel._tcp`.
The Studio page and its settings answer only through Home Assistant; tablets on the network cannot reach them.
