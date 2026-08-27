-- CreateIndex
CREATE INDEX `location_coord_lat_coord_lng_idx` ON `location`(`coord_lat`, `coord_lng`);

-- CreateIndex
CREATE INDEX `carpool_search_status_role_idx` ON `carpool_search`(`status`, `role`);
